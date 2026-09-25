/* ============================================================
   自分史 & 喜怒哀楽 & スケジュール – app.js
   ------------------------------------------------------------
   共有リンクは「id（このプロフィール専用のランダムID）＋復号鍵
   （URLのフラグメント）」のみで構成される。内容は暗号化された
   うえで GAS 経由でスプレッドシートに保存され、復号鍵はサーバー
   に送信されない（URLの # 以降はブラウザからサーバーへ送信され
   ないため）。
   このアプリは継続的に編集し続けるプロフィールという性質上、
   id・鍵は端末に保存して使い回し、プレビュー画面の送信ボタンを
   押すたびに同じリンクのまま中身だけを最新の内容に更新する。
   ============================================================ */

const LIFF_ID = "2010312230-3gcd1xq6";
const DRAFT_KEY = "konkatsu_selfintroduction_draft";
const SHARE_INFO_KEY = "konkatsu_selfintroduction_share";
const SHARE_VIEW_PENDING_KEY = "konkatsu_selfintroduction_shared_view_pending";
const PX_PER_MIN = 2; // 2px/分 で比例タイムライン描画

// ▼▼▼ デプロイ済みGAS Web AppのURL ▼▼▼
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbx5WGcdJTouhHJRSBIKDPVKYw4lODtSo-MtGHnLWctusDWcOe4jGdf4Th_-ZAZu9ZtBLg/exec";

/* ---- カテゴリ ---- */
const CATEGORY_LIST = [
  "小学校入学前","小学校","中学校","高校","高専","専門学校","短期大学","大学","大学院","会社","その他",
];
const DEFAULT_STARTER_CATEGORIES = ["小学校入学前","小学校","中学校","高校","大学","会社"];
const CARD_FIELD_ORDER = [
  "category","categoryName","startYear","startAge","endYear","endAge",
  "orgName","livedPlace","hobby","lessons","bestMemory","onePhrase",
];

/* ---- トリセツ質問定義 ---- */
const TORISETSU_QUESTIONS = [
  { id:"tq1", emotion:"joy",    kanji:"喜", label:"うれしい・たのしい",
    q:"最近、人からしてもらって嬉しかったことはなんですか？" },
  { id:"tq2", emotion:"joy",    kanji:"喜", label:"うれしい・たのしい",
    q:"今の自分の自慢（仕事でも家事でも趣味でもなんでも）" },
  { id:"tq3", emotion:"anger",  kanji:"怒", label:"いかり・ストレス",
    q:"イラつくことがあるとどうなるタイプですか？（黙り込む・すぐカッとなる・いったん持ち帰ってから冷静に話したい　など）" },
  { id:"tq4", emotion:"anger",  kanji:"怒", label:"いかり・ストレス",
    q:"ストレス発散方法はなんですか？" },
  { id:"tq5", emotion:"sorrow", kanji:"哀", label:"かなしい・落ち込む",
    q:"最近落ち込んだ出来事" },
  { id:"tq6", emotion:"sorrow", kanji:"哀", label:"かなしい・落ち込む",
    q:"落ち込んだ時はどうしてほしいですか？（一人にしてほしい・話を聞いてほしい・いつも通りにしてほしい　など）希望を教えてください。" },
  { id:"tq7", emotion:"fun",    kanji:"楽", label:"たのしい・しあわせ",
    q:"家族や友人と盛り上がる話題はどんなジャンルが多いですか？" },
  { id:"tq8", emotion:"fun",    kanji:"楽", label:"たのしい・しあわせ",
    q:"「人生が充実している、幸せだ」と感じる瞬間はどんな場面ですか？" },
];

/* ---- スケジュール グローバル状態 ---- */
let schedulePatterns = [];
let activePatternId  = null;

/* ============================================================
   ユーティリティ
   ============================================================ */
function generateId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

function escapeHTML(str){
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ------------------------------------------------------------
   スクショ抑止用ウォーターマーク
   ------------------------------------------------------------
   スクリーンショットの撮影自体は検知・ブロックできないため、
   「撮られても誰が・いつ見た画面かが写り込む」ようにし、
   無断転載・拡散への心理的な抑止力として機能させる。
   ------------------------------------------------------------ */
function buildWatermarkSVG(lines){
  const tileW = 240, tileH = 140;
  const lineHeight = 16;
  const startY = tileH / 2 - ((lines.length - 1) * lineHeight) / 2;

  const textEls = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    return `<text x="0" y="${y}" font-size="12" font-family="sans-serif" ` +
           `fill="rgba(0,0,0,0.1)" transform="rotate(-28 ${tileW / 2} ${tileH / 2})">${escapeHTML(line)}</text>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}">${textEls}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function showScreenshotWatermark(viewerHash){
  const el = document.getElementById("screenshotWatermark");
  if(!el) return;
  const stamp = new Date().toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const lines = [
    "スクショ・転載禁止",
    `${viewerHash.slice(0, 8)}  ${stamp}`,
  ];
  el.style.backgroundImage = `url("${buildWatermarkSVG(lines)}")`;
  el.classList.add("show");
}

/* ============================================================
   Base64URL 変換ユーティリティ（AES鍵・暗号文の符号化に使用）
   ============================================================ */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlToBuf(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad    = padded.length % 4;
  const fixed  = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(fixed);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ============================================================
   SHA-256ハッシュ（LINE UserIDのハッシュ化。生IDはサーバーに送らない）
   ============================================================ */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   AES-GCM 暗号化ユーティリティ
   鍵はURLのフラグメント（#以降）＋端末のlocalStorageにのみ保持し、
   サーバーには渡さない。
   ============================================================ */
async function generateShareKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return { key, base64: bufToBase64Url(raw) };
}

// 閲覧側（復号専用）
async function importShareKey(base64) {
  const raw = base64UrlToBuf(base64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

// 本人側（保存済みの鍵を再利用して再暗号化するため encrypt/decrypt 両方の用途で読み込む）
async function importShareKeyFull(base64) {
  const raw = base64UrlToBuf(base64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptJSON(obj, key) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return bufToBase64Url(combined.buffer);
}

async function decryptJSON(base64, key) {
  const combined = new Uint8Array(base64UrlToBuf(base64));
  const iv   = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/* crypto.randomUUID が使えない古い環境用のフォールバック */
function fallbackUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* ============================================================
   共有情報（id・鍵）の端末保存
   同じリンクを使い続けるため、生成したid・鍵をここに保存しておく。
   ============================================================ */
function loadShareInfo() {
  try {
    const raw = localStorage.getItem(SHARE_INFO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
function saveShareInfo(info) {
  try { localStorage.setItem(SHARE_INFO_KEY, JSON.stringify(info)); } catch (_) {}
}

function timeToMinutes(t){
  if(!t) return null;
  const [h,m] = t.split(":").map(Number);
  return h*60+(m||0);
}

/* 時間帯ブロックの背景色（時間帯別） */
function slotBgColor(startMinutes){
  const h = startMinutes/60;
  if(h<6)  return "#e8eaf6";
  if(h<9)  return "#fde8ec";
  if(h<12) return "#deeeff";
  if(h<14) return "#fff8e1";
  if(h<18) return "#e8f5e9";
  if(h<21) return "#fbe9e7";
  return "#f3e5f5";
}

/* ============================================================
   生年月日 ⇄ 年齢・年の相互計算
   ============================================================ */
function getBirthYear(){
  const el = document.getElementById("profileBirthdate");
  if(!el||!el.value) return null;
  const y = parseInt(el.value.slice(0,4),10);
  return isNaN(y)?null:y;
}
function ageFromYear(year,by){ const y=parseInt(year,10); return (isNaN(y)||!by)?"":String(y-by); }
function yearFromAge(age,by){  const a=parseInt(age,10);  return (isNaN(a)||!by)?"":String(by+a); }
function syncYearAgePair(yearEl,ageEl){
  const by=getBirthYear(); if(!by) return;
  const yv=yearEl.value.trim(), av=ageEl.value.trim();
  if(yv!==""&&av===""){ const a=ageFromYear(yv,by); if(a!=="") ageEl.value=a; }
  else if(av!==""&&yv===""){ const y=yearFromAge(av,by); if(y!=="") yearEl.value=y; }
}

/* ============================================================
   自分史カード
   ============================================================ */
let createdAt = null;

function createCardData(o={}){
  return Object.assign({
    category:"",categoryName:"",startYear:"",startAge:"",endYear:"",endAge:"",
    orgName:"",livedPlace:"",hobby:"",lessons:"",bestMemory:"",onePhrase:"",
  },o);
}

function renderCard(cardData){
  const tpl  = document.getElementById("cardTemplate");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const sel  = node.querySelector(".card-category");
  sel.innerHTML =
    `<option value="" disabled ${cardData.category?"":"selected"}>カテゴリを選択</option>` +
    CATEGORY_LIST.map(c=>`<option value="${escapeHTML(c)}" ${c===cardData.category?"selected":""}>${escapeHTML(c)}</option>`).join("");
  const otherF = node.querySelector(".other-category-field");
  otherF.classList.toggle("hidden",cardData.category!=="その他");
  const fm={
    ".card-categoryName":"categoryName",".card-startYear":"startYear",".card-startAge":"startAge",
    ".card-endYear":"endYear",".card-endAge":"endAge",".card-orgName":"orgName",
    ".card-livedPlace":"livedPlace",".card-hobby":"hobby",".card-lessons":"lessons",
    ".card-bestMemory":"bestMemory",".card-onePhrase":"onePhrase",
  };
  Object.keys(fm).forEach(s=>{ const el=node.querySelector(s); if(el) el.value=cardData[fm[s]]||""; });
  sel.addEventListener("change",()=>{
    otherF.classList.toggle("hidden",sel.value!=="その他");
    if(sel.value!=="その他") node.querySelector(".card-categoryName").value="";
    saveDraft();
  });
  const sYr=node.querySelector(".card-startYear"),sAg=node.querySelector(".card-startAge");
  const eYr=node.querySelector(".card-endYear"),  eAg=node.querySelector(".card-endAge");
  [sYr,sAg].forEach(el=>el.addEventListener("blur",()=>{ syncYearAgePair(sYr,sAg); saveDraft(); }));
  [eYr,eAg].forEach(el=>el.addEventListener("blur",()=>{ syncYearAgePair(eYr,eAg); saveDraft(); }));
  node.querySelector(".delete-card").addEventListener("click",()=>{
    if(!confirm("このカードを削除しますか？")) return;
    const list=node.parentElement;
    node.remove();
    if(list) updateMoveButtons(list);
    saveDraft();
  });
  node.querySelector(".move-up").addEventListener("click",()=>{
    const list=node.parentElement, prev=node.previousElementSibling;
    if(!prev) return;
    list.insertBefore(node,prev);
    updateMoveButtons(list); saveDraft();
  });
  node.querySelector(".move-down").addEventListener("click",()=>{
    const list=node.parentElement, next=node.nextElementSibling;
    if(!next) return;
    list.insertBefore(next,node);
    updateMoveButtons(list); saveDraft();
  });
  const cardList=document.getElementById("cardList");
  cardList.appendChild(node);
  updateMoveButtons(cardList);
  return node;
}

/* 一覧内での並び替えボタン（▲▼）の有効/無効状態を更新する
   （先頭要素は上へ、末尾要素は下へ移動できないためボタンを無効化） */
function updateMoveButtons(container){
  const items=[...container.children];
  items.forEach((item,i)=>{
    const upBtn=item.querySelector(".move-up");
    const downBtn=item.querySelector(".move-down");
    if(upBtn)   upBtn.disabled  = (i===0);
    if(downBtn) downBtn.disabled= (i===items.length-1);
  });
}

const DEFAULT_STARTER_RANGES={
  "小学校入学前":{startAge:0,endAge:6},"小学校":{startAge:6,endAge:12},
  "中学校":{startAge:12,endAge:15},"高校":{startAge:15,endAge:18},
  "大学":{startAge:18,endAge:22},"会社":{startAge:22},
};

function addCard(data){ renderCard(data||createCardData()); saveDraft(); }

function addStarterCards(){
  const by=getBirthYear();
  DEFAULT_STARTER_CATEGORIES.forEach(cat=>{
    const r=DEFAULT_STARTER_RANGES[cat]||{};
    const sA=r.startAge!==undefined?String(r.startAge):"";
    const eA=r.endAge  !==undefined?String(r.endAge)  :"";
    const sY=(by&&sA!=="")? yearFromAge(sA,by):"";
    const eY=(by&&eA!=="")? yearFromAge(eA,by):"";
    renderCard(createCardData({category:cat,startAge:sA,endAge:eA,startYear:sY,endYear:eY}));
  });
  saveDraft();
}

/* ============================================================
   スケジュール（入力UI）
   ============================================================ */
function createPattern(o={}){
  return Object.assign({id:generateId(),name:"新しいパターン",sublabel:"",slots:[]},o);
}
function createSlot(o={}){
  return Object.assign({id:generateId(),startTime:"",endTime:"",activity:""},o);
}

/* スロットDOMを1行分生成して返す */
function buildSlotEl(slot,patternId){
  const div=document.createElement("div");
  div.className="sched-slot"; div.dataset.slotid=slot.id;
  div.innerHTML=`
    <div class="move-buttons">
      <button class="move-up" type="button" aria-label="上に移動">▲</button>
      <button class="move-down" type="button" aria-label="下に移動">▼</button>
    </div>
    <div class="sched-slot-content">
      <div class="sched-slot-times">
        <input type="time" class="sched-slot-start" value="${escapeHTML(slot.startTime||"")}">
        <span class="sched-slot-sep">〜</span>
        <input type="time" class="sched-slot-end"   value="${escapeHTML(slot.endTime||"")}">
      </div>
      <input type="text" class="sched-slot-activity" value="${escapeHTML(slot.activity||"")}" placeholder="起床・通勤・食事など">
    </div>
    <button class="sched-slot-delete" type="button" aria-label="削除">×</button>`;
  /* イベントをスロットオブジェクトと同期 */
  div.querySelector(".sched-slot-start").addEventListener("change",e=>{ slot.startTime=e.target.value; saveDraft(); });
  div.querySelector(".sched-slot-end"  ).addEventListener("change",e=>{ slot.endTime  =e.target.value; saveDraft(); });
  div.querySelector(".sched-slot-activity").addEventListener("input",e=>{ slot.activity=e.target.value; saveDraft(); });
  div.querySelector(".sched-slot-delete").addEventListener("click",()=>{
    const p=schedulePatterns.find(p=>p.slots.some(s=>s.id===slot.id)); if(!p) return;
    if(!confirm("この時間帯を削除しますか？")) return;
    const list=div.parentElement;
    p.slots=p.slots.filter(s=>s.id!==slot.id); div.remove();
    if(list) updateMoveButtons(list);
    saveDraft();
  });
  div.querySelector(".move-up").addEventListener("click",()=>{
    const list=div.parentElement, prev=div.previousElementSibling;
    if(!prev) return;
    list.insertBefore(div,prev);
    reorderSlots(list,patternId);
  });
  div.querySelector(".move-down").addEventListener("click",()=>{
    const list=div.parentElement, next=div.nextElementSibling;
    if(!next) return;
    list.insertBefore(next,div);
    reorderSlots(list,patternId);
  });
  return div;
}

/* スロットの並び替えボタン操作後、DOM順序をデータへ反映しボタン状態を更新する */
function reorderSlots(listEl,patternId){
  const p=schedulePatterns.find(p=>p.id===patternId);
  if(p){
    const order=[...listEl.querySelectorAll(".sched-slot")].map(el=>el.dataset.slotid);
    p.slots.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
  }
  updateMoveButtons(listEl);
  saveDraft();
}

/* アクティブパターン編集エリアを再描画 */
function renderActivePatternEditor(){
  const el=document.getElementById("scheduleActivePattern"); if(!el) return;
  const p=schedulePatterns.find(p=>p.id===activePatternId);
  if(!p){ el.innerHTML=""; return; }

  el.innerHTML=`
    <div class="sched-active-card">
      <div class="sched-active-header">
        <span>
          <span class="sched-active-name">${escapeHTML(p.name)}</span>
          ${p.sublabel?`<span class="sched-active-sublabel">（${escapeHTML(p.sublabel)}）</span>`:""}
        </span>
        <button class="sched-pattern-menu-btn" type="button" title="名前変更・削除">⋮</button>
      </div>
      <div class="sched-slot-list" id="slotList-${escapeHTML(p.id)}"></div>
      <button class="sched-add-slot-btn" type="button">＋ 時間帯を追加</button>
    </div>`;

  const listEl=el.querySelector(`#slotList-${p.id}`);
  p.slots.forEach(s=>listEl.appendChild(buildSlotEl(s,p.id)));
  updateMoveButtons(listEl);

  el.querySelector(".sched-add-slot-btn").addEventListener("click",()=>{
    const slot=createSlot(); p.slots.push(slot);
    listEl.appendChild(buildSlotEl(slot,p.id));
    updateMoveButtons(listEl); saveDraft();
  });

  el.querySelector(".sched-pattern-menu-btn").addEventListener("click",()=>{
    const action=window.prompt(`「${p.name}」の操作を入力してください\n\n「1」 → 名前を変更\n「2」 → このパターンを削除`);
    if(action==="1"){
      const newName=window.prompt("新しいパターン名：",p.name);
      if(newName&&newName.trim()){ p.name=newName.trim(); renderScheduleUI(); saveDraft(); }
    } else if(action==="2"){
      if(schedulePatterns.length<=1){ alert("パターンが1つしかないため削除できません。"); return; }
      if(!window.confirm(`「${p.name}」を削除しますか？`)) return;
      schedulePatterns=schedulePatterns.filter(x=>x.id!==p.id);
      activePatternId=schedulePatterns[0]?.id||null;
      renderScheduleUI(); saveDraft();
    }
  });
}

/* タブ・折りたたみカードを再描画 */
function renderScheduleUI(){
  /* タブ行 */
  const tabsEl=document.getElementById("schedulePatternTabs"); if(!tabsEl) return;
  tabsEl.innerHTML=schedulePatterns.map(p=>`
    <button class="sched-tab-btn ${p.id===activePatternId?"active":""}"
            data-pid="${escapeHTML(p.id)}" type="button">${escapeHTML(p.name)}</button>
  `).join("")+`<button class="sched-tab-add" id="schedTabAddBtn" type="button">＋ 追加</button>`;

  tabsEl.querySelectorAll(".sched-tab-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{ activePatternId=btn.dataset.pid; renderScheduleUI(); });
  });
  tabsEl.querySelector("#schedTabAddBtn").addEventListener("click",addSchedulePattern);

  /* アクティブパターン編集エリア */
  renderActivePatternEditor();

  /* 非アクティブ パターン（折りたたみカード） */
  const inactEl=document.getElementById("scheduleInactivePatterns"); if(!inactEl) return;
  const inactive=schedulePatterns.filter(p=>p.id!==activePatternId);
  inactEl.innerHTML=inactive.map(p=>`
    <div class="sched-collapsed-card" data-pid="${escapeHTML(p.id)}">
      <span>
        <span class="sched-collapsed-name">${escapeHTML(p.name)}</span>
        ${p.sublabel?`<span class="sched-collapsed-sublabel">（${escapeHTML(p.sublabel)}）</span>`:""}
      </span>
      <svg viewBox="0 0 24 24" class="sched-chevron"><path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2"/></svg>
    </div>`).join("");
  inactEl.querySelectorAll(".sched-collapsed-card").forEach(card=>{
    card.addEventListener("click",()=>{ activePatternId=card.dataset.pid; renderScheduleUI(); });
  });
}

function addSchedulePattern(){
  const name=window.prompt("新しいパターン名を入力してください（例：土曜日・特別な日など）");
  if(!name||!name.trim()) return;
  const p=createPattern({name:name.trim()});
  schedulePatterns.push(p); activePatternId=p.id;
  renderScheduleUI(); saveDraft();
}

/* ============================================================
   入力値の収集
   ============================================================ */
function collectProfile(){
  return{
    name:      document.getElementById("profileName").value.trim(),
    age:       document.getElementById("profileAge").value.trim(),
    birthdate: document.getElementById("profileBirthdate").value.trim(),
  };
}
function collectCards(){
  return[...document.querySelectorAll("#cardList .life-card")].map(node=>({
    category:     node.querySelector(".card-category").value,
    categoryName: node.querySelector(".card-categoryName").value.trim(),
    startYear:    node.querySelector(".card-startYear").value.trim(),
    startAge:     node.querySelector(".card-startAge").value.trim(),
    endYear:      node.querySelector(".card-endYear").value.trim(),
    endAge:       node.querySelector(".card-endAge").value.trim(),
    orgName:      node.querySelector(".card-orgName").value.trim(),
    livedPlace:   node.querySelector(".card-livedPlace").value.trim(),
    hobby:        node.querySelector(".card-hobby").value.trim(),
    lessons:      node.querySelector(".card-lessons").value.trim(),
    bestMemory:   node.querySelector(".card-bestMemory").value.trim(),
    onePhrase:    node.querySelector(".card-onePhrase").value.trim(),
  }));
}
function collectTorisetsu(){
  return Object.fromEntries(
    TORISETSU_QUESTIONS.map(q=>[q.id,(document.getElementById(q.id)?.value||"").trim()])
  );
}

/* ============================================================
   下書き保存／復元
   ============================================================ */
function saveDraft(){
  try{
    localStorage.setItem(DRAFT_KEY,JSON.stringify({
      profile:   collectProfile(),
      cards:     collectCards(),
      torisetsu: collectTorisetsu(),
      schedule:  schedulePatterns,
      createdAt,
    }));
    flashSaved();
  }catch(e){ console.warn("draft save failed",e); }
}
function flashSaved(){
  const b=document.getElementById("saveStatus"); if(!b) return;
  b.classList.add("just-saved"); setTimeout(()=>b.classList.remove("just-saved"),400);
}

function loadDraft(){
  try{
    const raw=localStorage.getItem(DRAFT_KEY); if(!raw) return false;
    const data=JSON.parse(raw);
    document.getElementById("profileName").value      = data.profile?.name      ||"";
    document.getElementById("profileAge").value        = data.profile?.age       ||"";
    document.getElementById("profileBirthdate").value  = data.profile?.birthdate ||"";
    createdAt=data.createdAt||null;
    (data.cards||[]).forEach(c=>renderCard(createCardData(c)));
    const ts=data.torisetsu||{};
    TORISETSU_QUESTIONS.forEach(q=>{ const el=document.getElementById(q.id); if(el) el.value=ts[q.id]||""; });
    /* スケジュール: スロットにIDが無い場合は補完 */
    schedulePatterns=(data.schedule||[]).map(p=>({
      ...p,
      id: p.id||generateId(),
      slots: (p.slots||[]).map(s=>({...s,id:s.id||generateId()})),
    }));
    if(schedulePatterns.length===0){
      schedulePatterns=[
        createPattern({id:"work",    name:"仕事の日",sublabel:"平日の平均",    slots:[]}),
        createPattern({id:"holiday", name:"休日",    sublabel:"平均的な1日", slots:[]}),
      ];
    }
    activePatternId=schedulePatterns[0]?.id||null;
    return (data.cards&&data.cards.length>0)||!!(data.profile?.name)||
           Object.values(ts).some(v=>v!=="")||
           schedulePatterns.some(p=>p.slots.length>0);
  }catch(e){ console.warn("draft load failed",e); return false; }
}

/* ============================================================
   共有データの収集
   ============================================================ */
function collectShareData(){
  const profile = collectProfile();
  return {
    profile: { name: profile.name||"", age: profile.age||"" }, // 生年月日は共有対象外
    cards: collectCards(),
    torisetsu: collectTorisetsu(),
    schedule: schedulePatterns,
    createdAt: createdAt||"",
  };
}
function getFormBaseURL(){ return location.href.split("?")[0].split("#")[0]; }

/* ------------------------------------------------------------
   LINEユーザーIDの取得
   liff.getProfile() はLINEサーバーへの追加API呼び出しが必要で、
   ログイン直後などタイミングによって不安定になりやすい。
   ログイン時に発行されるIDトークンをその場でデコードするだけなら
   通信が発生せず、ユーザーID（sub）を安定して取得できる。
   ------------------------------------------------------------ */
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) {
    throw new Error("ID token is not available (sub claim missing)");
  }
  return idToken.sub;
}

/* ============================================================
   共有の公開／更新（GAS連携）
   ------------------------------------------------------------
   ・端末に保存済みのid・鍵があれば使い回そうとする（＝同じ共有
     リンクのまま中身だけ最新化される）。無ければ新規に発行する。
   ・ただし、その保存済みリンクをすでに誰かが開いていた場合は、
     サーバー側が新しいidを発行して返してくる。その場合はここで
     新しいidを採用し、以後はそのidを使い回す（鍵は変えない）。
   ・戻り値: 発行された共有URL
   ============================================================ */
async function publishAndShare(shareName){
  if(!createdAt){ createdAt=new Date().toISOString(); saveDraft(); }

  const shareData = collectShareData();

  let shareInfo = loadShareInfo();
  let cryptoKey;
  if(shareInfo){
    cryptoKey = await importShareKeyFull(shareInfo.key);
  }else{
    const generated = await generateShareKey();
    cryptoKey = generated.key;
    shareInfo = { id: (crypto.randomUUID ? crypto.randomUUID() : fallbackUUID()), key: generated.base64 };
  }

  const cipherText = await encryptJSON(shareData, cryptoKey);

  const userId    = getLineUserId();
  const ownerHash = await sha256Hex(userId);

  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避のため text/plain を使用
    body: JSON.stringify({ action: "share", id: shareInfo.id, cipherText, ownerHash }),
  });

  if(!resp.ok){
    // GAS側(doPost)まで届く前にGoogleのゲートウェイ等で弾かれているケース。
    // ここで実際のレスポンス本文をログに出しておくと原因特定に役立つ。
    const bodyText = await resp.text().catch(()=>"(本文を取得できませんでした)");
    console.error(`share request failed: HTTP ${resp.status} ${resp.statusText}`, bodyText);
    throw new Error(`http_${resp.status}`);
  }

  const result = await resp.json();
  if(!result.ok) throw new Error(result.reason || "share_failed");

  // サーバーが新しいidを発行した場合（＝保存済みリンクがすでに誰かに
  // 開かれていたため新しい行になった場合）はそちらを採用する。
  // 鍵は変更しない（同じ鍵をそのまま使い回す）。
  shareInfo = { id: result.id, key: shareInfo.key };
  saveShareInfo(shareInfo);

  const shareURL = `${getFormBaseURL()}?id=${shareInfo.id}#${shareInfo.key}`;
  const name = (shareName||"").trim();
  const previewMsg = name
    ? `${name}さんの恋活・婚活プロフィールが届きました。\n回答をみる→${shareURL}`
    : `恋活・婚活プロフィールが届きました。\n回答をみる→${shareURL}`;

  return { shareURL, previewMsg, flexMessage: buildShareFlexMessage(name, shareURL) };
}

/* ============================================================
   フォーム要素を隠す（公開ビュー／状態表示に切り替える共通処理）
   ============================================================ */
function showPublicState(title, text, isLoading = false){
  document.getElementById("app").style.display = "none";
  const pv = document.getElementById("publicView");
  pv.style.display = "block";
  pv.innerHTML = `
    <div class="state-card">
      ${isLoading ? `
        <div class="state-spinner">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_light.svg" class="spinner-light" alt="読み込み中">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_dark.svg" class="spinner-dark" alt="読み込み中">
        </div>
      ` : ""}
      <p class="state-title">${escapeHTML(title)}</p>
      <p class="state-text">${escapeHTML(text)}</p>
    </div>
  `;
}

/* ============================================================
   共有リンクを開いたときの処理
   ・URLの ?id=... がスプレッドシート上のレコードを指す
   ・URLの #以降 が復号鍵（サーバーには送信されない）
   ・閲覧にはLINEログインが必須（viewerHashによるアクセス制御のため）
   ============================================================ */
async function handleSharedView(id, keyBase64){
  showPublicState("読み込み中…", "内容を確認しています。少々お待ちください。", true);

  if(!keyBase64){
    showPublicState(
      "リンクが不完全です",
      "共有リンクが途中で切れているか、正しくコピーされていない可能性があります。共有した相手にもう一度リンクを送ってもらってください。"
    );
    return;
  }

  try{
    await liff.init({ liffId: LIFF_ID });
  }catch(e){
    console.error("LIFF init failed", e);
    showPublicState("エラー", "LIFFの初期化に失敗しました。時間をおいて再度お試しください。");
    return;
  }

  if(!liff.isLoggedIn()){ liff.login(); return; }

  // ここまで来ればリダイレクトは発生しないはずなので、一時保存していた
  // 復元用の情報は不要になる（消し忘れて別のリンクに誤って使われるのを防ぐ）
  try{ sessionStorage.removeItem(SHARE_VIEW_PENDING_KEY); }catch(_){}

  let key;
  try{
    key = await importShareKey(keyBase64);
  }catch(e){
    console.error("key import error", e);
    showPublicState("リンクが正しくありません", "共有リンクが壊れている可能性があります。");
    return;
  }

  let viewerHash;
  try{
    const userId = getLineUserId();
    viewerHash = await sha256Hex(userId);
  }catch(e){
    console.error("get user id error", e);
    showPublicState(
      "エラー",
      "LINEアカウント情報の確認に失敗しました。時間をおいてもう一度お試しください。" +
      "（詳細: " + (e && e.message ? e.message : String(e)) + "）"
    );
    return;
  }

  let result;
  try{
    const url = `${GAS_ENDPOINT}?action=view&id=${encodeURIComponent(id)}&viewerHash=${encodeURIComponent(viewerHash)}`;
    const resp = await fetch(url, { method: "GET" });
    result = await resp.json();
  }catch(e){
    console.error("fetch view error", e);
    showPublicState("通信エラー", "内容を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return;
  }

  if(!result.ok){
    if(result.reason === "forbidden"){
      showPublicState(
        "閲覧できません",
        "このリンクは最初に開いた方専用です。転送されたリンクは、その方以外は閲覧できない仕組みになっています。"
      );
    }else if(result.reason === "revoked" || result.reason === "expired" || result.reason === "deleted"){
      showPublicState("リンクが無効です", "このリンクはすでに無効になっています。最新の共有リンクを送ってもらってください。");
    }else if(result.reason === "not_found"){
      showPublicState("リンクが見つかりません", "このリンクは存在しないか、削除された可能性があります。");
    }else{
      showPublicState("エラー", "内容を取得できませんでした。時間をおいて再度お試しください。");
    }
    return;
  }

  let data;
  try{
    data = await decryptJSON(result.cipherText, key);
  }catch(e){
    console.error("decrypt error", e);
    showPublicState("復号に失敗しました", "リンクの一部が正しくない可能性があります。共有した相手にもう一度リンクを送ってもらってください。");
    return;
  }

  renderPublicView(data);
  showScreenshotWatermark(viewerHash);
}

/* ============================================================
   表示用 HTML ビルダー
   ============================================================ */
function decoFlourishSVG(){
  return`<svg viewBox="0 0 160 28" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 14 C32 3,50 25,76 13 S122 1,154 14" fill="none" stroke="#f4b8c5" stroke-width="2" stroke-linecap="round"/>
    <circle cx="24" cy="9" r="2.6" fill="#f48ca0"/><circle cx="58" cy="19" r="2.6" fill="#f48ca0"/>
    <circle cx="96" cy="8" r="2.6" fill="#f48ca0"/><circle cx="132" cy="18" r="2.6" fill="#f48ca0"/>
  </svg>`;
}

const CAT_ICONS={
  home:`<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10v9h14v-9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  school:`<svg viewBox="0 0 24 24"><path d="M12 4 2 9l10 5 10-5-10-5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M6 11.5V17c0 1 2.7 2 6 2s6-1 6-2v-5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  work:`<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  spark:`<svg viewBox="0 0 24 24"><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.5 5.5l4 4M14.5 14.5l4 4M18.5 5.5l-4 4M9.5 14.5l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  dot:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`,
};
function catIconKind(c){
  if(!c) return"dot"; if(c==="小学校入学前") return"home";
  if(["小学校","中学校","高校","高専","専門学校","短期大学","大学","大学院"].includes(c)) return"school";
  if(c==="会社") return"work"; return"spark";
}
function catIconHTML(c){ return`<span class="cat-icon">${CAT_ICONS[catIconKind(c)]}</span>`; }

function formatPeriod(card){
  const{startYear:y1,endYear:y2,startAge:a1,endAge:a2}=card;
  const yp=(y1&&y2)?`${y1}〜${y2}`:y1?`${y1}〜`:y2?`〜${y2}`:"";
  const ap=(a1!==""&&a2!=="")?`（${a1}〜${a2}歳）`:a1!==""?`（${a1}歳〜）`:a2!==""?`（〜${a2}歳）`:"";
  return[yp,ap].filter(Boolean).join("")||"期間未設定";
}
function formatDateLabel(iso){
  if(!iso) return""; const d=new Date(iso);
  if(isNaN(d.getTime())) return"";
  return`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}

/* ---- 自分史タイムライン ---- */
function buildTimelineHTML(profile,cards,dateLabel){
  const items=cards.map(card=>{
    const period=formatPeriod(card);
    const catLabel=card.category==="その他"?(card.categoryName||"その他"):card.category;
    const rows=[
      ["学校名・施設名",card.orgName],["住んでいた場所",card.livedPlace],
      ["趣味",card.hobby],["習い事・部活動",card.lessons],
      ["一番の思い出",card.bestMemory],["一言で表すと",card.onePhrase],
    ].filter(([,v])=>v&&String(v).trim()!=="");
    return`
      <div class="timeline-item">
        <div class="timeline-rail"><span class="timeline-dot"></span></div>
        <div class="timeline-card">
          <p class="timeline-period">${escapeHTML(period)}</p>
          <p class="timeline-category">${catIconHTML(card.category)}<span>${escapeHTML(catLabel||"（カテゴリ未設定）")}</span></p>
          ${rows.map(([l,v])=>`<div class="field-row"><span class="field-row-label">${escapeHTML(l)}</span><span class="field-row-value">${escapeHTML(v).replace(/\n/g,"<br>")}</span></div>`).join("")}
        </div>
      </div>`;
  }).join("");
  return`
    <div class="timeline-header">
      <div class="timeline-header-deco">${decoFlourishSVG()}</div>
      <p class="timeline-header-title">自分史</p>
      <p class="timeline-header-sub">MY STORY</p>
      <div class="timeline-profile">
        <div class="avatar-circle">${escapeHTML((profile.name||"?").trim().slice(0,1)||"?")}</div>
        <div><p class="timeline-profile-name">${escapeHTML(profile.name||"名前未設定")}${profile.age?`（${escapeHTML(String(profile.age))}歳）`:""}</p></div>
      </div>
      ${dateLabel?`<p class="timeline-date">作成日：${escapeHTML(dateLabel)}</p>`:""}
    </div>
    <div class="timeline-list">${items||`<div class="timeline-empty">まだ出来事が登録されていません</div>`}</div>`;
}

/* ---- 喜怒哀楽表示 ---- */
const EMOTION_GROUPS=[
  {key:"joy",   kanji:"喜",label:"うれしい・たのしい", ids:["tq1","tq2"]},
  {key:"anger", kanji:"怒",label:"いかり・ストレス",   ids:["tq3","tq4"]},
  {key:"sorrow",kanji:"哀",label:"かなしい・落ち込む", ids:["tq5","tq6"]},
  {key:"fun",   kanji:"楽",label:"たのしい・しあわせ", ids:["tq7","tq8"]},
];
function buildTorisetsuHTML(torisetsu){
  const hasAny=TORISETSU_QUESTIONS.some(q=>(torisetsu[q.id]||"").trim()!=="");
  const groupsHTML=EMOTION_GROUPS.map(g=>{
    const qaHTML=TORISETSU_QUESTIONS.filter(q=>g.ids.includes(q.id)).map(q=>{
      const ans=(torisetsu[q.id]||"").trim(); if(!ans) return"";
      return`<div class="torisetsu-qa">
        <p class="torisetsu-question">${escapeHTML(q.q)}</p>
        <p class="torisetsu-answer">${escapeHTML(ans).replace(/\n/g,"<br>")}</p>
      </div>`;
    }).join("");
    if(!qaHTML) return"";
    return`<div class="torisetsu-emotion-block torisetsu-${g.key}">
      <div class="torisetsu-emotion-heading">
        <span class="torisetsu-kanji-badge badge-${g.key}">${escapeHTML(g.kanji)}</span>
        <span>${escapeHTML(g.label)}</span>
      </div>${qaHTML}</div>`;
  }).join("");
  return`
    <div class="torisetsu-view-header">
      <div class="torisetsu-view-header-deco">${decoFlourishSVG()}</div>
      <p class="torisetsu-view-title">喜怒哀楽</p>
      <p class="torisetsu-view-sub">喜怒哀楽からよむ、わたしの感情と価値観</p>
    </div>
    ${hasAny?groupsHTML:`<div class="timeline-empty">まだ回答が入力されていません</div>`}`;
}

/* ---- スケジュール表示 ---- */
const COL_HEADER_COLORS=[
  {bg:"#fde8ec",color:"#d96c7d"},{bg:"#deeeff",color:"#4060b8"},
  {bg:"#e8f5e9",color:"#5a9040"},{bg:"#fff8e1",color:"#b08000"},
  {bg:"#f3e5f5",color:"#7040a0"},{bg:"#e0f7fa",color:"#006878"},
];

function buildScheduleViewHTML(patterns, leftIdx, rightIdx){
  const showIdxs=[leftIdx, rightIdx].filter(i=>i>=0&&i<patterns.length);
  const showPats=showIdxs.map(i=>patterns[i]);
  const allEmpty=showPats.every(p=>!p.slots||p.slots.length===0);
  if(showPats.length===0||allEmpty){
    return`<div class="timeline-empty">スケジュールが登録されていません</div>`;
  }

  /* 時間範囲を算出 */
  let minMin=Infinity, maxMin=-Infinity;
  showPats.forEach(p=>(p.slots||[]).forEach(s=>{
    const sm=timeToMinutes(s.startTime), em=timeToMinutes(s.endTime);
    if(sm!==null) minMin=Math.min(minMin,sm);
    if(em!==null) maxMin=Math.max(maxMin,em);
  }));
  if(minMin===Infinity) return`<div class="timeline-empty">時間帯が登録されていません</div>`;
  minMin=Math.floor(minMin/60)*60; maxMin=Math.ceil(maxMin/60)*60;
  const range=maxMin-minMin; const totalH=range*PX_PER_MIN;
  const hourPx=60*PX_PER_MIN;

  /* グラデーション（1時間ごとの区切り線） */
  const bgGrad=`repeating-linear-gradient(to bottom,transparent 0px,transparent ${hourPx-1}px,rgba(0,0,0,0.05) ${hourPx-1}px,rgba(0,0,0,0.05) ${hourPx}px)`;

  /* 時軸 */
  const axisLabels=[];
  for(let m=minMin;m<=maxMin;m+=60){
    const top=(m-minMin)*PX_PER_MIN;
    axisLabels.push(`<div class="sched-hour-label" style="top:${top}px">${Math.floor(m/60)}:00</div>`);
  }
  const axisHTML=`
    <div class="sched-axis-col">
      <div class="sched-col-header-spacer"></div>
      <div class="sched-axis-body" style="height:${totalH}px;position:relative;">${axisLabels.join("")}</div>
    </div>`;

  /* パターン列 */
  const colsHTML=showPats.map((p,ci)=>{
    const hc=COL_HEADER_COLORS[showIdxs[ci]%COL_HEADER_COLORS.length];
    const blocks=(p.slots||[]).map(s=>{
      const sm=timeToMinutes(s.startTime); if(sm===null) return"";
      const em=timeToMinutes(s.endTime);
      const top=(sm-minMin)*PX_PER_MIN;
      const ht=em!==null?Math.max((em-sm)*PX_PER_MIN,20):hourPx;
      const bg=slotBgColor(sm);
      const timeStr=s.endTime?`${s.startTime}〜${s.endTime}`:s.startTime;
      return`<div class="sched-block" style="top:${top}px;height:${ht}px;background:${bg}">
        <span class="sched-block-time">${escapeHTML(timeStr)}</span>
        <span class="sched-block-activity">${escapeHTML(s.activity||"")}</span>
      </div>`;
    }).join("");
    return`
      <div class="sched-pattern-col">
        <div class="sched-col-header" style="background:${hc.bg};color:${hc.color}">
          <span class="sched-col-name">${escapeHTML(p.name)}</span>
          ${p.sublabel?`<span class="sched-col-sublabel">（${escapeHTML(p.sublabel)}）</span>`:""}
        </div>
        <div class="sched-col-body" style="height:${totalH}px;position:relative;background:${bgGrad}">${blocks}</div>
      </div>`;
  }).join("");

  const numCols=showPats.length;
  const gridCols=`48px ${Array(numCols).fill("1fr").join(" ")}`;

  /* 追加パターンタブ（3つ目以降） */
  const extraIdxs=patterns.map((_,i)=>i).filter(i=>!showIdxs.includes(i));
  const extraHTML=extraIdxs.length>0?`
    <div class="sched-extra-row">
      <span class="sched-extra-label">他のパターンも見る</span>
      <div class="sched-extra-tabs">
        ${extraIdxs.map(i=>`<button class="sched-extra-tab" data-idx="${i}" type="button">${escapeHTML(patterns[i].name)}</button>`).join("")}
      </div>
      <span class="sched-extra-hint">ボタンを押すと右列が切り替わります</span>
    </div>`:"";

  return`
    <div class="sched-view-wrapper">
      <div class="sched-grid-wrapper" style="grid-template-columns:${gridCols}">
        ${axisHTML}${colsHTML}
      </div>
      ${extraHTML}
    </div>`;
}

/* スケジュール表示をDOMにマウントし、追加タブのイベントも設定 */
function mountScheduleView(container, patterns){
  let leftIdx=0, rightIdx=Math.min(1,patterns.length-1);
  function render(){
    const wrapper=container.querySelector(".sched-section-body");
    if(!wrapper) return;
    wrapper.innerHTML=buildScheduleViewHTML(patterns,leftIdx,rightIdx);
    wrapper.querySelectorAll(".sched-extra-tab").forEach(btn=>{
      btn.addEventListener("click",()=>{ rightIdx=parseInt(btn.dataset.idx,10); render(); });
    });
  }
  container.querySelector(".sched-section-body").innerHTML=buildScheduleViewHTML(patterns,leftIdx,rightIdx);
  container.querySelector(".sched-section-body").querySelectorAll(".sched-extra-tab").forEach(btn=>{
    btn.addEventListener("click",()=>{ rightIdx=parseInt(btn.dataset.idx,10);
      container.querySelector(".sched-section-body").innerHTML=buildScheduleViewHTML(patterns,leftIdx,rightIdx);
      // 再バインド
      container.querySelector(".sched-section-body").querySelectorAll(".sched-extra-tab").forEach(b=>{
        b.addEventListener("click",()=>{ rightIdx=parseInt(b.dataset.idx,10); render(); });
      });
    });
  });
}

/* ============================================================
   プレビュー・公開ビュー レンダリング
   ============================================================ */
function renderContent(container,profile,cards,torisetsu,schedule,opts={}){
  const{showViewerCTA=false}=opts;
  const dateLabel=formatDateLabel(createdAt||"");
  const schedHasData=(schedule||[]).some(p=>p.slots&&p.slots.length>0);

  container.innerHTML=
    buildTimelineHTML(profile,cards,dateLabel)+
    buildTorisetsuHTML(torisetsu)+
    `<div class="sched-view-header">
       <div class="sched-view-header-deco">${decoFlourishSVG()}</div>
       <p class="sched-view-title">生活スタイル・スケジュール</p>
       <p class="sched-view-sub">DAILY SCHEDULE</p>
     </div>
     <div class="sched-section-body"></div>`+
    (showViewerCTA?`
    <div class="cta-card">
      <p class="cta-title">あなたも自分史・トリセツを作ってみませんか？</p>
      <p class="cta-text">生い立ちから今までの歩みと、喜怒哀楽・生活リズムをまとめてお相手に届けられます。</p>
      <button type="button" class="btn-primary cta-btn" id="ctaCreateBtn">私も作成する</button>
    </div>`:"");

  if(schedule&&schedule.length>0){
    mountScheduleView(container,schedule);
  } else {
    const sb=container.querySelector(".sched-section-body");
    if(sb) sb.innerHTML=`<div class="timeline-empty">スケジュールが登録されていません</div>`;
  }

  if(showViewerCTA){
    const btn=container.querySelector("#ctaCreateBtn");
    if(btn) btn.addEventListener("click",()=>{ location.href=getFormBaseURL(); });
  }
}

function renderPublicView(shared){
  document.getElementById("app").style.display="none";
  const pv=document.getElementById("publicView"); pv.style.display="block";
  createdAt=shared.createdAt||null;
  renderContent(pv,shared.profile,shared.cards,shared.torisetsu,shared.schedule,{showViewerCTA:true});
}

/* ============================================================
   タブ・サブタブ切り替え
   ============================================================ */
function switchTab(tab){
  ["input","preview","settings"].forEach(t=>{
    document.getElementById(`tab-${t}`).classList.toggle("hidden",t!==tab);
  });
  document.querySelectorAll(".nav-btn").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.tab===tab);
  });
  const title={preview:"プレビュー",settings:"設定"};
  document.getElementById("appBarTitle").textContent=title[tab]||"作成";

  if(tab==="preview"){
    if(!createdAt){ createdAt=new Date().toISOString(); saveDraft(); }
    renderContent(
      document.getElementById("previewContent"),
      collectProfile(),collectCards(),collectTorisetsu(),schedulePatterns,
      {showViewerCTA:false}
    );
  }
}

let currentSub="story";
function switchSub(sub){
  ["story","torisetsu","schedule"].forEach(s=>{
    document.getElementById(`sub-${s}`).classList.toggle("hidden",s!==sub);
  });
  document.querySelectorAll(".sub-switch-btn").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.sub===sub);
  });
  const titles={story:"自分史",torisetsu:"喜怒哀楽",schedule:"スケジュール"};
  document.getElementById("appBarTitle").textContent=titles[sub]||"作成";
  currentSub=sub;
  if(sub==="schedule") renderScheduleUI();
}

/* ============================================================
   イベント登録
   ============================================================ */
function bindEvents(){
  document.getElementById("addCardBtn").addEventListener("click",()=>addCard());

  let saveTimer=null;
  document.getElementById("tab-input").addEventListener("input",()=>{
    clearTimeout(saveTimer); saveTimer=setTimeout(saveDraft,500);
  });

  document.getElementById("profileBirthdate").addEventListener("blur",()=>{
    document.querySelectorAll("#cardList .life-card").forEach(card=>{
      syncYearAgePair(card.querySelector(".card-startYear"),card.querySelector(".card-startAge"));
      syncYearAgePair(card.querySelector(".card-endYear"),  card.querySelector(".card-endAge"));
    });
    saveDraft();
  });

  document.querySelectorAll(".nav-btn").forEach(btn=>{
    btn.addEventListener("click",()=>switchTab(btn.dataset.tab));
  });
  document.querySelectorAll(".sub-switch-btn").forEach(btn=>{
    btn.addEventListener("click",()=>switchSub(btn.dataset.sub));
  });
  document.getElementById("backToInputBtn").addEventListener("click",()=>switchTab("input"));
  document.getElementById("addPatternBtn").addEventListener("click",addSchedulePattern);

  /* ----- 送信ボタン（プレビュー画面上部） ----- */
  document.getElementById("sendBtn").addEventListener("click",()=>{
    const modal=document.getElementById("shareModal");
    document.getElementById("shareName").value="";
    modal.classList.remove("hidden");
    modal.classList.add("show");
  });

  /* ----- 共有モーダル：共有する ----- */
  document.getElementById("shareBtn").addEventListener("click",async()=>{
    const shareBtn=document.getElementById("shareBtn");
    const shareName=document.getElementById("shareName").value;

    shareBtn.disabled=true;
    const originalLabel=shareBtn.textContent;
    shareBtn.textContent="送信中…";

    try{
      const { flexMessage, previewMsg, shareURL } = await publishAndShare(shareName);

      const modal=document.getElementById("shareModal");
      modal.classList.remove("show");
      modal.classList.add("hidden");

      const lineURL=`https://line.me/R/msg/text/?${encodeURIComponent(previewMsg)}`;
      await shareToOthers(flexMessage,previewMsg,lineURL);
    }catch(e){
      console.error("share error",e);
      alert("送信に失敗しました。通信環境を確認してもう一度お試しください。");
    }finally{
      shareBtn.disabled=false;
      shareBtn.textContent=originalLabel;
    }
  });

  /* ----- モーダル外クリックで閉じる ----- */
  document.getElementById("shareModal").addEventListener("click",(e)=>{
    if(e.target===e.currentTarget){
      e.currentTarget.classList.remove("show");
      e.currentTarget.classList.add("hidden");
    }
  });

  document.getElementById("resetBtn").addEventListener("click",()=>{
    if(!confirm("下書きを削除して最初から作成しますか？この操作は取り消せません。")) return;
    try{ localStorage.removeItem(DRAFT_KEY); }catch(_){}
    try{ localStorage.removeItem(SHARE_INFO_KEY); }catch(_){}
    location.href=getFormBaseURL();
  });

}

/* ============================================================
   共有：シェアターゲットピッカー用 Flexメッセージ
   長い共有URLはボタン(uriアクション)の中に格納するため、
   相手に見える本文には長いリンクが表示されない。
   ※ uriアクションのURLは1000文字以内という制限があるため、
     超える場合は liff.shareTargetPicker 側でエラーになり、
     呼び出し元で従来のURLスキーム方式にフォールバックする。
   ※ hero画像のURLは、LINEのサーバーから読み込める公開HTTPS URL
     である必要がある（ローカルパスや相対パスは不可）。
     画像は1MB以下を推奨。PNGの透過部分はそのまま送ると
     反映されない場合があるため、白背景に合成したJPEGを使用する。
   ============================================================ */
const SHARETARGETPICKER_IMAGE_URL = "https://marriagesketch.github.io/-selfintroduction-/sharetargetpicker.jpg";

function buildShareFlexMessage(name, shareURL){
  const nameLine = name ? `${name}さんの恋活・婚活プロフィールが届きました` : "回答が届きました";

  return {
    type: "flex",
    altText: `恋活・婚活プロフィール - ${nameLine}`,
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: SHARETARGETPICKER_IMAGE_URL,
        size: "full",
        aspectRatio: "3:2",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "恋活・婚活プロフィール", size: "xs", weight: "bold", color: "#d96c7d" },
          { type: "text", text: nameLine, size: "lg", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "ボタンから内容を確認できます。", size: "sm", color: "#888888", wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#f48ca0",
            action: { type: "uri", label: "回答をみる", uri: shareURL }
          }
        ]
      }
    }
  };
}

/* ------------------------------------------------------------
   共有先を選んで送信する
   1. シェアターゲットピッカーが使える場合、まずFlexメッセージ
      （カード形式）での送信を試みる
   2. Flexが失敗した場合（URLが長すぎる等）は、同じ複数選択画面の
      ままテキストメッセージとして再送信を試みる
      （テキストメッセージにはFlexボタンのuriのような1000文字の
      制限が無いため、Flexで失敗したケースでも通りやすい）
   3. それでも失敗した場合、または端末がシェアターゲットピッカー
      自体に対応していない場合は、従来のURLスキーム方式（送信先を
      選択画面を開いてテキストメッセージを送る）にフォールバック
   ------------------------------------------------------------ */
async function shareToOthers(flexMessage, textPreviewMsg, fallbackLineSchemeURL){
  if(liff.isApiAvailable("shareTargetPicker")){
    try{
      await liff.shareTargetPicker([flexMessage], { isMultiple: true });
      return;
    }catch(e){
      console.warn("shareTargetPicker (flex) failed, retrying as text:", e);
    }

    try{
      await liff.shareTargetPicker(
        [{ type: "text", text: textPreviewMsg }],
        { isMultiple: true }
      );
      return;
    }catch(e){
      console.warn("shareTargetPicker (text) failed, falling back to URL scheme:", e);
    }
  }

  if(liff.isInClient()){ window.location.href = fallbackLineSchemeURL; }
  else{ window.open(fallbackLineSchemeURL, "_blank"); }
}

/* ============================================================
   友だち追加チェック
   ※ LIFF初期化・ログイン済みの状態で呼び出すこと（liff.init は呼ばない）
   ============================================================ */
async function checkFriendship(){
  try{
    const friendship = await liff.getFriendship();
    if(!friendship.friendFlag){
      try{
        await liff.requestFriendship();
      }catch(error){
        console.warn("友だち追加リクエスト失敗（ユーザーがキャンセルした可能性があります）:", error);
      }
    }
  }catch(error){
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ============================================================
   複数アプリ一括下書き移行チェーン 受け取り処理
   （恋活・婚活すり合わせシリーズ 5サイト共通スニペット。中身は全サイト同一）
   ============================================================ */
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get("migrate") !== "1" || !location.hash) return;

  window.__migrationInProgress = true;

  try {
    const idx = parseInt(params.get("idx") || "0", 10);
    const encoded = location.hash.slice(1);
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const chain = JSON.parse(new TextDecoder().decode(bytes));

    const item = chain[idx];
    if (item && item.value != null) {
      localStorage.setItem(item.draftKey, item.value);
    }

    const next = chain[idx + 1];
    if (next) {
      // まだ移行先が残っている → 次のサイトへ自動遷移
      location.href = `${next.targetOrigin}?migrate=1&idx=${idx + 1}#${encoded}`;
    } else {
      // チェーンの最後 = 全件移行完了
      alert("下書きデータの移行がすべて完了しました。");
      history.replaceState(null, "", location.origin + location.pathname);
      window.__migrationInProgress = false;
    }
  } catch (e) {
    console.error("draft migration failed", e);
    alert("下書きデータの移行中にエラーが発生しました。お手数ですが運営までご連絡ください。");
    history.replaceState(null, "", location.origin + location.pathname);
    window.__migrationInProgress = false;
  }
})();

/* ============================================================
   メイン処理
   ============================================================ */
(async()=>{
  // 移行チェーンの転送中（次サイトへの中継のみ）は、
  // 通常のLIFF初期化・アプリ本処理を一切実行しない
  if (window.__migrationInProgress) return;

  const params = new URLSearchParams(location.search);
  let sharedId  = params.get("id");
  let keyBase64 = location.hash ? location.hash.slice(1) : "";

  // liff.init()/liff.login() が内部でリダイレクト（ログイン・友だち追加など）
  // を行うと、URLのクエリ(id)やフラグメント(復号鍵)が失われることがある。
  // そのため、リダイレクト前に一度sessionStorageへ保存しておき、リダイレクト
  // 後に情報が欠けていたらそこから補完する。
  let pending = null;
  try{ pending = JSON.parse(sessionStorage.getItem(SHARE_VIEW_PENDING_KEY) || "null"); }catch(_){}

  if(sharedId && keyBase64){
    try{ sessionStorage.setItem(SHARE_VIEW_PENDING_KEY, JSON.stringify({ id: sharedId, key: keyBase64 })); }catch(_){}
  }else if(pending && (!sharedId || pending.id === sharedId)){
    if(!sharedId)  sharedId  = pending.id;
    if(!keyBase64) keyBase64 = pending.key;
  }

  if(sharedId){ await handleSharedView(sharedId, keyBase64); return; }

  try{ await liff.init({liffId:LIFF_ID}); }
  catch(e){ console.error("LIFF init failed",e); alert("LIFFの初期化に失敗しました。"); return; }

  if(!liff.isLoggedIn()){ liff.login(); return; }

  /* LIFF初期化・ログイン後に友だち確認（未追加ならダイアログで追加を促す）
     liff.getFriendship() / requestFriendship() はLINEサーバーへの通信を
     伴うため、ここをawaitすると電波が悪い時に画面表示自体が止まって
     しまう。必須の処理ではないので、裏側で実行させて画面構築は
     先に進める（fire-and-forget）。 */
  checkFriendship();

  const hadDraft=loadDraft();

  /* スケジュールの初期データが無ければデフォルト2パターン設定 */
  if(schedulePatterns.length===0){
    schedulePatterns=[
      createPattern({id:"work",    name:"仕事の日",sublabel:"平日の平均",    slots:[]}),
      createPattern({id:"holiday", name:"休日",    sublabel:"平均的な1日", slots:[]}),
    ];
    activePatternId=schedulePatterns[0].id;
  }

  bindEvents();

  const startBtn =document.getElementById("startBtn");
  const resumeBtn=document.getElementById("resumeBtn");
  if(hadDraft){ resumeBtn.classList.remove("hidden"); startBtn.textContent="新しく作成する"; }

  function goToMain(){
    document.getElementById("screen-top").classList.add("hidden");
    document.getElementById("screen-main").classList.remove("hidden");
    switchTab("input"); switchSub("story");
  }

  startBtn.addEventListener("click",()=>{
    if(hadDraft&&!confirm("これまでの下書きを削除して、新しく作成しますか？")) return;
    if(hadDraft){
      document.getElementById("cardList").innerHTML="";
      document.getElementById("profileName").value="";
      document.getElementById("profileAge").value="";
      document.getElementById("profileBirthdate").value="";
      TORISETSU_QUESTIONS.forEach(q=>{ const el=document.getElementById(q.id); if(el) el.value=""; });
      schedulePatterns=[
        createPattern({id:"work",    name:"仕事の日",sublabel:"平日の平均",    slots:[]}),
        createPattern({id:"holiday", name:"休日",    sublabel:"平均的な1日", slots:[]}),
      ];
      activePatternId=schedulePatterns[0].id;
      createdAt=null;
      try{ localStorage.removeItem(DRAFT_KEY); }catch(_){}
      try{ localStorage.removeItem(SHARE_INFO_KEY); }catch(_){}
    }
    if(document.querySelectorAll("#cardList .life-card").length===0) addStarterCards();
    goToMain();
  });
  resumeBtn.addEventListener("click",goToMain);
})();
