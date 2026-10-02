/* ============================================================
   結婚準備スケジュール – GAS バックエンド (schedule_code.gs)
   ------------------------------------------------------------
   【方式：プロポーズプランと同じ「自動ペア判定＋自動暗号鍵取得」】
   ・クライアントが送るのは ownerHash（LINE userIdのSHA-256）だけ。
   ・毎回 Partners中央API に ownerHash を問い合わせ、
     「現在の真剣交際パートナー」と「ペア専用の pairKey」を取得する。
   ・同じペアの2人は同じ pairKey を得るので、同じデータ領域
     （pairKeyHash）を自動的に共有する。リンクや暗号キーの入力は不要。
   ・タスク本体は pairKey 由来のAES鍵でクライアント側で暗号化して保存。
     このシートには pairKey の生値も平文のタスク内容も残らない。
   ・プロポーズプランと違い「入力完了」の概念は無く、タスク1件ごとに
     保存した時点で相手にも反映される（相手の画面は次回の同期で更新）。
   ・同じタスクを2人が同時に編集した場合は、後から保存した方が優先
     （タスク単位の last-write-wins）。
   ・交際終了後は Partners 側で active でなくなるため、
     自動的に読み書きできなくなる。
   ------------------------------------------------------------
   シート構成:
   ・「Tasks」 … 暗号化済みタスク（1タスク＝1行。削除は deleted=TRUE の墓標行）
   ------------------------------------------------------------
   デプロイ方法:
   1. スプレッドシートを開き「拡張機能 > Apps Script」にこのコードを貼る。
   2. SPREADSHEET_ID を設定する。
   3. スクリプトプロパティ INTERNAL_SECRET を設定（Partners用GASと同じ値）。
   4. 「デプロイ > 新しいデプロイ > ウェブアプリ」（実行：自分／アクセス：全員）
      で発行された /exec URL を app.js の GAS_ENDPOINT に設定する。
   ============================================================ */

var SPREADSHEET_ID = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // ← スケジュール用スプレッドシートIDに差し替え
var SHEET_NAME     = 'Tasks';
var DATA_START_ROW = 2;

// Tasks シートの列番号（1-indexed）
var COL = {
  TASK_ID: 1, PAIR_KEY_HASH: 2, CIPHER_TEXT: 3, DELETED: 4,
  UPDATED_BY: 5, CREATED_AT: 6, UPDATED_AT: 7
};
var HEADER = ['taskId', 'pairKeyHash', 'cipherText', 'deleted', 'updatedBy', 'createdAt', 'updatedAt'];

var MAX_ITEMS_PER_SAVE = 50;
var MAX_CIPHER_LENGTH  = 20000; // セル上限(50,000文字)に対する余裕

/* ------------------------------------------------------------
   Partners中央APIとの連携（propose_code.gs と同一）
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec';
var INTERNAL_SECRET   = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';
var PARTNER_CACHE_SECONDS = 120;

function resolvePartner(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { ok: false, active: false, everPartnered: false, partnerHash: '', pairKey: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        ok: true,
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || '',
        pairKey: body.pairKey || ''
      };
    }
  } catch (err) {
    Logger.log('resolvePartner failed: ' + err);
  }
  if (result.ok && result.active) {
    cache.put(cacheKey, JSON.stringify(result), PARTNER_CACHE_SECONDS);
  }
  return result;
}

function partnerReason(resolved) {
  if (!resolved.ok) return 'server_error';
  if (resolved.active) return null;
  if (resolved.everPartnered) return 'partner_ended';
  return 'no_partner';
}

function sha256HexGS(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    if (e.parameter.action === 'fetchTasks') {
      return handleFetchTasks(e.parameter.ownerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'save') {
      return handleSave(body);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ------------------------------------------------------------
   action=fetchTasks
   現在のパートナー情報＋pairKey＋このペアの全タスク（墓標含む）を返す。
   ------------------------------------------------------------ */
function handleFetchTasks(ownerHash) {
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var resolved = resolvePartner(ownerHash);
  var reason = partnerReason(resolved);
  if (reason) return jsonResponse({ ok: false, reason: reason });

  var pairKeyHash = sha256HexGS('lookup:' + resolved.pairKey);
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  var tasks = [];

  if (lastRow >= DATA_START_ROW) {
    var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, HEADER.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v[COL.PAIR_KEY_HASH - 1] !== pairKeyHash) continue;
      tasks.push({
        id: v[COL.TASK_ID - 1],
        cipherText: v[COL.CIPHER_TEXT - 1],
        deleted: !!v[COL.DELETED - 1],
        updatedAt: toMillis(v[COL.UPDATED_AT - 1])
      });
    }
  }

  return jsonResponse({
    ok: true,
    pairKey: resolved.pairKey,
    partnerHash: resolved.partnerHash,
    tasks: tasks
  });
}

/* ------------------------------------------------------------
   action=save
   body: { ownerHash, insertOnly, items: [{ id, cipherText, deleted }] }
   ・insertOnly=true : 既に存在するタスクは上書きしない（初期タスクの
                       二重作成を防ぐため。2人が同時に初回起動しても安全）
   ・deleted=true    : 墓標行にする（相手の端末にも削除が伝わる）
   ・pairKeyHash はクライアントから受け取らず、必ず自分で導出する。
   ------------------------------------------------------------ */
function handleSave(body) {
  var ownerHash  = body.ownerHash;
  var items      = body.items;
  var insertOnly = !!body.insertOnly;

  if (!ownerHash || !Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_PER_SAVE) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    if (!it || typeof it.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(it.id)) {
      return jsonResponse({ ok: false, reason: 'invalid_params' });
    }
    if (!it.deleted) {
      if (typeof it.cipherText !== 'string' || !it.cipherText || it.cipherText.length > MAX_CIPHER_LENGTH) {
        return jsonResponse({ ok: false, reason: 'invalid_params' });
      }
    }
  }

  var resolved = resolvePartner(ownerHash);
  var reason = partnerReason(resolved);
  if (reason) return jsonResponse({ ok: false, reason: reason });

  var pairKeyHash = sha256HexGS('lookup:' + resolved.pairKey);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var now = new Date();

    // このペアの既存行を taskId → 行番号 で一括取得
    var rowMap = {};
    var lastRow = sheet.getLastRow();
    if (lastRow >= DATA_START_ROW) {
      var existing = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.PAIR_KEY_HASH).getValues();
      for (var i = 0; i < existing.length; i++) {
        if (existing[i][COL.PAIR_KEY_HASH - 1] === pairKeyHash) {
          rowMap[existing[i][COL.TASK_ID - 1]] = DATA_START_ROW + i;
        }
      }
    }

    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var deleted = !!item.deleted;
      var cipher = deleted ? '' : item.cipherText;
      var rowIndex = rowMap[item.id];

      if (rowIndex) {
        if (insertOnly) continue;
        var createdAt = sheet.getRange(rowIndex, COL.CREATED_AT).getValue() || now;
        sheet.getRange(rowIndex, 1, 1, HEADER.length).setValues([[
          item.id, pairKeyHash, cipher, deleted, ownerHash, createdAt, now
        ]]);
      } else {
        if (deleted) continue; // 存在しないものの削除は不要
        sheet.appendRow([item.id, pairKeyHash, cipher, false, ownerHash, now, now]);
      }
    }

    return jsonResponse({ ok: true, updatedAt: now.getTime() });
  } finally {
    lock.releaseLock();
  }
}

function toMillis(v) {
  if (v instanceof Date) return v.getTime();
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}
