/* ============================================================
   結婚準備タスク管理 – app.js（UIプロトタイプ版）
   ------------------------------------------------------------
   ・データはこの端末の localStorage にのみ保存されます。
   ・LIFFログイン／サーバー保存／共有機能は未実装です。
   ============================================================ */

const STORAGE_KEY = "wedding_schedule_tasks_v1";
const COLLAPSE_KEY = "wedding_schedule_collapse_v1";

const CATEGORIES = [
  { id:"engage",  title:"婚約までのスケジュール",   cls:"cat-engage",
    dot:"var(--cat-engage-deep)" },
  { id:"nyuseki", title:"入籍前後のスケジュール",    cls:"cat-nyuseki",
    dot:"var(--cat-nyuseki-deep)" },
  { id:"future",  title:"将来のスケジュール",       cls:"cat-future",
    dot:"var(--cat-future-deep)" },
];
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c=>[c.id,c]));

const DEFAULT_TASK_NAMES = {
  engage:  ["親挨拶","婚約指輪購入","プロポーズ"],
  nyuseki: ["家の契約","引越し","両家顔合わせ","結婚指輪購入","入籍","新婚旅行","結婚式"],
  future:  ["妊活開始の希望時期"],
};

const WEEK = ["日","月","火","水","木","金","土"];

/* ---- 状態 ---- */
let tasks = [];
let collapseState = {};
let currentScreen = "home";
let editingTaskId = null;   // null かつ editingIsNew=true の場合は新規
let editingIsNew = false;
let editingCategory = null;
let calYear, calMonth;      // 表示中の年月（0-11）
let calSelectedDate = null;
let calMode = "month";
let listFilter = "all";
let pendingCalendarData = null;

/* ============================================================
   ユーティリティ
   ============================================================ */
function generateId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
function pad(n){ return String(n).padStart(2,"0"); }
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function parseDateStr(s){
  if(!s) return null;
  const [y,m,d] = s.split("-").map(Number);
  return new Date(y, m-1, d);
}
function formatShortDate(dateStr){
  const d = parseDateStr(dateStr);
  if(!d) return "";
  return `${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}
function daysUntilLabel(dateStr){
  const d = parseDateStr(dateStr);
  const t = parseDateStr(todayStr());
  if(!d) return "";
  const diff = Math.round((d - t) / 86400000);
  if(diff === 0) return "今日";
  if(diff > 0) return `あと${diff}日`;
  return `${Math.abs(diff)}日前`;
}
function escapeHTML(str){
  return String(str ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ---- カレンダー連携（.ics生成 / Googleカレンダー） ---- */
function dateStrToICSDate(dateStr){
  return dateStr.replace(/-/g,"");
}
function addDaysToDateStrAsICS(dateStr, days){
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate()+days);
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}
function escapeICSText(str){
  return String(str || "")
    .replace(/\\/g,"\\\\").replace(/;/g,"\\;")
    .replace(/,/g,"\\,").replace(/\n/g,"\\n");
}
function formatICSTimestamp(date){
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
function buildICSContent({ name, dateStr, memo, reminderDays }){
  const dtStart = dateStrToICSDate(dateStr);
  const dtEnd = addDaysToDateStrAsICS(dateStr, 1);
  const uid = `${generateId()}@wedding-task-app`;
  const dtStamp = formatICSTimestamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//wedding-task-app//JP",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;VALUE=DATE:${dtStart}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `SUMMARY:${escapeICSText(name)}`,
  ];
  if(memo) lines.push(`DESCRIPTION:${escapeICSText(memo)}`);
  if(reminderDays !== "" && reminderDays !== undefined && reminderDays !== null){
    const n = Math.max(0, parseInt(reminderDays, 10) || 0);
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeICSText(name)}`);
    lines.push(`TRIGGER:-P${n}D`);
    lines.push("END:VALARM");
  }
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
function downloadICS(data){
  const content = buildICSContent(data);
  const blob = new Blob([content], { type:"text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (data.name || "task").replace(/[\\/:*?"<>|]/g, "_");
  a.download = `${safeName}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
function buildGoogleCalendarURL({ name, dateStr, memo }){
  const start = dateStrToICSDate(dateStr);
  const end = addDaysToDateStrAsICS(dateStr, 1);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: name,
    dates: `${start}/${end}`,
  });
  if(memo) params.set("details", memo);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/* ============================================================
   永続化
   ============================================================ */
function createDefaultTasks(){
  const list = [];
  CATEGORIES.forEach(cat=>{
    DEFAULT_TASK_NAMES[cat.id].forEach((name, idx)=>{
      list.push({
        id: generateId(),
        category: cat.id,
        name,
        status: "notStarted",
        date: null,
        assignee: "both",
        memo: "",
        reminderDays: "",
        completedDate: null,
        order: idx,
      });
    });
  });
  return list;
}

function loadTasks(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed) && parsed.length) return parsed;
    }
  }catch(_){}
  const defaults = createDefaultTasks();
  saveTasksImmediate(defaults);
  return defaults;
}
function saveTasksImmediate(list){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }catch(_){}
}
function saveTasks(){ saveTasksImmediate(tasks); }

function loadCollapse(){
  try{
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(_){}
  return {};
}
function saveCollapse(){
  try{ localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapseState)); }catch(_){}
}

/* ============================================================
   画面切り替え
   ============================================================ */
function switchScreen(name){
  currentScreen = name;
  ["home","detail","calendar","settings"].forEach(s=>{
    document.getElementById(`screen-${s}`).classList.toggle("hidden", s!==name);
  });
  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.screen===name);
  });
  const nav = document.querySelector(".bottom-nav");
  nav.classList.toggle("hidden", name==="detail");
  if(name==="calendar") renderCalendar();
}

/* ============================================================
   ホーム画面：進捗 + カテゴリ一覧
   ============================================================ */
function renderHome(){
  const total = tasks.length;
  const done = tasks.filter(t=>t.status==="done").length;
  const pct = total ? Math.round((done/total)*100) : 0;
  document.getElementById("progressPct").textContent = `${pct}%`;
  document.getElementById("progressFill").style.width = `${pct}%`;
  document.getElementById("progressCount").textContent = `${done} / ${total} 完了`;

  const listEl = document.getElementById("categoryList");
  listEl.innerHTML = "";

  CATEGORIES.forEach(cat=>{
    const catTasks = tasks
      .filter(t=>t.category===cat.id)
      .sort((a,b)=> (a.order??0) - (b.order??0));
    const catDone = catTasks.filter(t=>t.status==="done").length;
    const collapsed = !!collapseState[cat.id];

    const block = document.createElement("div");
    block.className = `category-block ${cat.cls}${collapsed?" collapsed":""}`;
    block.innerHTML = `
      <button class="category-header" type="button" data-cat="${cat.id}">
        <span class="category-title">${escapeHTML(cat.title)}</span>
        <span class="category-count">${catDone}/${catTasks.length}</span>
        <svg class="category-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="task-rows">
        ${catTasks.map(t=>taskRowHTML(t)).join("")}
      </div>
      <button class="category-add-row" type="button" data-add-cat="${cat.id}">＋ タスクを追加</button>
    `;
    listEl.appendChild(block);
  });
}

function taskRowHTML(t){
  const done = t.status === "done";
  const dateBadge = t.date ? formatShortDate(t.date) : "未設定";
  const statusTag = t.status==="inProgress" ? `<span class="task-status-tag inProgress">進行中</span>` : "";
  return `
    <div class="task-row${done?" done":""}" data-task-id="${t.id}">
      <button class="task-checkbox" type="button" data-toggle-id="${t.id}" aria-label="完了にする">
        <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="task-name">${escapeHTML(t.name || "（無題のタスク）")}</span>
      ${statusTag}
      <span class="task-date-badge${t.date?" set":""}">${dateBadge}</span>
      <svg class="task-row-chevron" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`;
}

function toggleTaskQuick(id){
  const t = tasks.find(x=>x.id===id);
  if(!t) return;
  if(t.status === "done"){
    t.status = "notStarted";
    t.completedDate = null;
  }else{
    t.status = "done";
    t.completedDate = todayStr();
  }
  saveTasks();
  renderHome();
  if(currentScreen==="calendar") renderCalendar();
}

/* ============================================================
   タスク詳細
   ============================================================ */
function openDetail(taskId, newCategory){
  if(taskId){
    editingTaskId = taskId;
    editingIsNew = false;
    const t = tasks.find(x=>x.id===taskId);
    fillDetailForm(t);
    document.getElementById("detailDeleteBtn").classList.remove("hidden");
  }else{
    editingTaskId = null;
    editingIsNew = true;
    editingCategory = newCategory;
    fillDetailForm({
      name:"", status:"notStarted", date:null, assignee:"both", memo:"", reminderDays:"",
    });
    document.getElementById("detailDeleteBtn").classList.add("hidden");
  }
  switchScreen("detail");
}

function fillDetailForm(t){
  document.getElementById("detailName").value = t.name || "";
  document.getElementById("detailDate").value = t.date || "";
  document.getElementById("detailMemo").value = t.memo || "";
  document.getElementById("detailReminder").value = t.reminderDays || "";
  setPillGroup("statusPills", "status", t.status || "notStarted");
  setPillGroup("assigneePills", "assignee", t.assignee || "both");
}
function setPillGroup(groupId, dataAttr, value){
  document.querySelectorAll(`#${groupId} .pill`).forEach(p=>{
    p.classList.toggle("active", p.dataset[dataAttr]===value);
  });
}
function getPillValue(groupId, dataAttr){
  const active = document.querySelector(`#${groupId} .pill.active`);
  return active ? active.dataset[dataAttr] : null;
}

function closeDetail(){
  switchScreen("home");
}

function saveDetail(){
  const name = document.getElementById("detailName").value.trim();
  if(!name){
    alert("タスク名を入力してください。");
    return;
  }
  const newStatus = getPillValue("statusPills","status") || "notStarted";
  const wasDone = !editingIsNew && tasks.find(t=>t.id===editingTaskId)?.status === "done";
  const nowDone = newStatus === "done";

  const data = {
    name,
    status: newStatus,
    date: document.getElementById("detailDate").value || null,
    assignee: getPillValue("assigneePills","assignee") || "both",
    memo: document.getElementById("detailMemo").value,
    reminderDays: document.getElementById("detailReminder").value,
  };

  let savedTask;
  if(editingIsNew){
    savedTask = Object.assign({
      id: generateId(),
      category: editingCategory,
      completedDate: nowDone ? todayStr() : null,
      order: tasks.filter(t=>t.category===editingCategory).length,
    }, data);
    tasks.push(savedTask);
  }else{
    const t = tasks.find(x=>x.id===editingTaskId);
    Object.assign(t, data);
    if(nowDone && !wasDone) t.completedDate = todayStr();
    if(!nowDone) t.completedDate = null;
    savedTask = t;
  }
  saveTasks();
  renderHome();

  if(nowDone && !wasDone){
    showCompleteModal(savedTask);
  }else{
    closeDetail();
  }
}

function deleteDetail(){
  if(editingIsNew) { closeDetail(); return; }
  if(!confirm("このタスクを削除しますか？")) return;
  tasks = tasks.filter(t=>t.id!==editingTaskId);
  saveTasks();
  renderHome();
  closeDetail();
}

/* ---- 完了モーダル ---- */
function showCompleteModal(task){
  const cat = CATEGORY_MAP[task.category];
  document.getElementById("completeInfo").innerHTML = `
    <div>タスク：<span>${escapeHTML(task.name)}</span></div>
    <div>カテゴリ：<span>${cat ? escapeHTML(cat.title.replace("のスケジュール","")) : ""}</span></div>
    <div>完了日：<span>${task.completedDate ? formatShortDate(task.completedDate) : ""}</span></div>
    <div>担当：<span>${ {self:"自分",partner:"パートナー",both:"二人"}[task.assignee] || "" }</span></div>
  `;
  document.getElementById("completeModal").classList.remove("hidden");
}
function hideCompleteModal(){
  document.getElementById("completeModal").classList.add("hidden");
  closeDetail();
}

/* ---- カレンダー追加アクションシート ---- */
function openCalendarAddSheet(){
  const name = document.getElementById("detailName").value.trim();
  const dateStr = document.getElementById("detailDate").value;
  const memo = document.getElementById("detailMemo").value;
  const reminderDays = document.getElementById("detailReminder").value;
  if(!name){
    alert("タスク名を入力してください。");
    return;
  }
  if(!dateStr){
    alert("先に「希望日」を入力してください。");
    return;
  }
  pendingCalendarData = { name, dateStr, memo, reminderDays };
  document.getElementById("calendarAddModal").classList.remove("hidden");
}
function closeCalendarAddSheet(){
  document.getElementById("calendarAddModal").classList.add("hidden");
}

/* ============================================================
   カレンダー
   ============================================================ */
function tasksOnDate(dateStr){
  return tasks.filter(t=>t.date===dateStr);
}

function renderCalendar(){
  if(calMode==="month") renderCalMonth();
  else renderCalList();
}

function renderCalMonth(){
  document.getElementById("calMonthView").classList.remove("hidden");
  document.getElementById("calListView").classList.add("hidden");

  document.getElementById("calNavLabel").textContent = `${calYear}年${calMonth+1}月`;

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  const grid = document.getElementById("calGrid");
  grid.innerHTML = "";

  for(let i=0;i<firstDay;i++){
    const cell = document.createElement("div");
    cell.className = "cal-cell empty";
    grid.appendChild(cell);
  }
  const todStr = todayStr();
  for(let d=1; d<=daysInMonth; d++){
    const dateStr = `${calYear}-${pad(calMonth+1)}-${pad(d)}`;
    const dayTasks = tasksOnDate(dateStr);
    const cell = document.createElement("div");
    let cls = "cal-cell";
    if(dateStr===todStr) cls += " today";
    if(dateStr===calSelectedDate) cls += " selected";
    cell.className = cls;
    cell.dataset.date = dateStr;
    const dots = dayTasks.slice(0,3).map(t=>{
      const cat = CATEGORY_MAP[t.category];
      return `<span class="cal-dot" style="background:${cat?cat.dot:'#ccc'}"></span>`;
    }).join("");
    cell.innerHTML = `<span>${d}</span><div class="cal-dots">${dots}</div>`;
    grid.appendChild(cell);
  }

  renderCalDayPanel();
}

function renderCalDayPanel(){
  const titleEl = document.getElementById("calDayPanelTitle");
  const listEl = document.getElementById("calDayPanelList");
  if(!calSelectedDate){
    titleEl.textContent = "日付を選択してください";
    listEl.innerHTML = "";
    return;
  }
  const d = parseDateStr(calSelectedDate);
  titleEl.textContent = `${d.getMonth()+1}月${d.getDate()}日（${WEEK[d.getDay()]}）の予定`;
  const dayTasks = tasksOnDate(calSelectedDate);
  if(!dayTasks.length){
    listEl.innerHTML = `<p class="cal-day-task-empty">この日の予定はありません。</p>`;
    return;
  }
  listEl.innerHTML = dayTasks.map(t=>{
    const cat = CATEGORY_MAP[t.category];
    return `
      <div class="cal-day-task-row" data-task-id="${t.id}">
        <span class="cal-day-task-dot" style="background:${cat?cat.dot:'#ccc'}"></span>
        <span class="cal-day-task-name">${escapeHTML(t.name)}</span>
        <span class="task-date-badge set">${t.status==="done"?"完了":daysUntilLabel(t.date)}</span>
      </div>`;
  }).join("");
}

function renderCalList(){
  document.getElementById("calMonthView").classList.add("hidden");
  document.getElementById("calListView").classList.remove("hidden");

  let list = tasks.filter(t=>{
    if(listFilter==="pending") return t.status!=="done";
    if(listFilter==="done") return t.status==="done";
    return true;
  });
  const withDate = list.filter(t=>t.date).sort((a,b)=>a.date.localeCompare(b.date));
  const noDate = list.filter(t=>!t.date);

  const el = document.getElementById("calListContent");
  if(!withDate.length && !noDate.length){
    el.innerHTML = `<p class="list-empty">該当する予定はありません。</p>`;
    return;
  }
  let html = "";
  if(withDate.length){
    html += `<p class="list-section-title">予定</p>`;
    html += withDate.map(t=>listCardHTML(t, true)).join("");
  }
  if(noDate.length){
    html += `<p class="list-section-title">日付未定</p>`;
    html += noDate.map(t=>listCardHTML(t, false)).join("");
  }
  el.innerHTML = html;
}

function listCardHTML(t, hasDate){
  const cat = CATEGORY_MAP[t.category];
  const done = t.status==="done";
  const badge = done ? "完了" : (hasDate ? daysUntilLabel(t.date) : "");
  return `
    <div class="list-task-card" data-task-id="${t.id}">
      <span class="list-task-icon" style="background:${cat?cat.dot+'22':'#eee'}">${cat?cat.icon:""}</span>
      <div class="list-task-main">
        <div class="list-task-name${done?" done":""}">${escapeHTML(t.name)}</div>
        <div class="list-task-date">${hasDate?formatShortDate(t.date):"日付未定"}</div>
      </div>
      <span class="list-task-badge">${badge}</span>
    </div>`;
}

/* ============================================================
   設定
   ============================================================ */
function resetTasks(){
  if(!confirm("すべてのタスクを削除して初期状態に戻します。よろしいですか？")) return;
  tasks = createDefaultTasks();
  saveTasks();
  collapseState = {};
  saveCollapse();
  renderHome();
  switchScreen("home");
}

/* ============================================================
   イベントバインド
   ============================================================ */
function bindEvents(){
  // ボトムナビ
  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> switchScreen(btn.dataset.screen));
  });

  // ホーム：カテゴリ開閉・タスク行タップ・チェック・追加
  document.getElementById("categoryList").addEventListener("click", (e)=>{
    const toggleBtn = e.target.closest("[data-toggle-id]");
    if(toggleBtn){
      e.stopPropagation();
      toggleTaskQuick(toggleBtn.dataset.toggleId);
      return;
    }
    const addBtn = e.target.closest("[data-add-cat]");
    if(addBtn){
      openDetail(null, addBtn.dataset.addCat);
      return;
    }
    const header = e.target.closest(".category-header");
    if(header){
      const catId = header.dataset.cat;
      collapseState[catId] = !collapseState[catId];
      saveCollapse();
      renderHome();
      return;
    }
    const row = e.target.closest(".task-row");
    if(row){
      openDetail(row.dataset.taskId);
    }
  });

  // 詳細画面
  document.getElementById("detailBackBtn").addEventListener("click", closeDetail);
  document.getElementById("detailDeleteBtn").addEventListener("click", deleteDetail);
  document.getElementById("detailSaveBtn").addEventListener("click", saveDetail);
  document.getElementById("statusPills").addEventListener("click", (e)=>{
    const btn = e.target.closest(".pill"); if(!btn) return;
    setPillGroup("statusPills","status", btn.dataset.status);
  });
  document.getElementById("assigneePills").addEventListener("click", (e)=>{
    const btn = e.target.closest(".pill"); if(!btn) return;
    setPillGroup("assigneePills","assignee", btn.dataset.assignee);
  });

  // 完了モーダル
  document.getElementById("completeOkBtn").addEventListener("click", hideCompleteModal);

  // カレンダー追加アクションシート
  document.getElementById("addToCalendarBtn").addEventListener("click", openCalendarAddSheet);
  document.getElementById("addIcsBtn").addEventListener("click", ()=>{
    if(pendingCalendarData) downloadICS(pendingCalendarData);
    closeCalendarAddSheet();
  });
  document.getElementById("addGoogleBtn").addEventListener("click", ()=>{
    if(pendingCalendarData) window.open(buildGoogleCalendarURL(pendingCalendarData), "_blank");
    closeCalendarAddSheet();
  });
  document.getElementById("calendarAddCancelBtn").addEventListener("click", closeCalendarAddSheet);

  // カレンダー：モード切替
  document.querySelectorAll(".cal-mode-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      calMode = btn.dataset.mode;
      document.querySelectorAll(".cal-mode-btn").forEach(b=>b.classList.toggle("active", b===btn));
      renderCalendar();
    });
  });
  document.getElementById("calPrevBtn").addEventListener("click", ()=>{
    calMonth--; if(calMonth<0){ calMonth=11; calYear--; }
    renderCalMonth();
  });
  document.getElementById("calNextBtn").addEventListener("click", ()=>{
    calMonth++; if(calMonth>11){ calMonth=0; calYear++; }
    renderCalMonth();
  });
  document.getElementById("calGrid").addEventListener("click", (e)=>{
    const cell = e.target.closest(".cal-cell:not(.empty)");
    if(!cell) return;
    calSelectedDate = cell.dataset.date;
    renderCalMonth();
  });
  document.getElementById("calDayPanelList").addEventListener("click", (e)=>{
    const row = e.target.closest("[data-task-id]");
    if(row) openDetail(row.dataset.taskId);
  });
  document.querySelectorAll(".list-filter-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      listFilter = btn.dataset.filter;
      document.querySelectorAll(".list-filter-btn").forEach(b=>b.classList.toggle("active", b===btn));
      renderCalList();
    });
  });
  document.getElementById("calListContent").addEventListener("click", (e)=>{
    const card = e.target.closest("[data-task-id]");
    if(card) openDetail(card.dataset.taskId);
  });

  // 設定
  document.getElementById("resetBtn").addEventListener("click", resetTasks);
}

/* ============================================================
   初期化
   ============================================================ */
(function init(){
  tasks = loadTasks();
  collapseState = loadCollapse();
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  calSelectedDate = todayStr();

  bindEvents();
  renderHome();
  switchScreen("home");
})();
