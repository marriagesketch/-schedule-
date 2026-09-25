/* ============================================================
   婚活プロフィール（自分史＆喜怒哀楽＆スケジュール） – GAS バックエンド (Code.gs)
   スプレッドシートID: 18EsNFzS77rYcL1jGiGJ-JtOCCcyDGO1dVh9FSCUJjg4
   ------------------------------------------------------------
   ・シート「sheet」のみ作成（Analyticsシートは作成しない）
   ------------------------------------------------------------
   共有リンクの扱い（ハイブリッド方式）:
   ・まだ誰にも開かれていない間は、同じid・同じリンクのまま
     中身だけ上書き更新する（＝編集してもリンクは変わらない）。
   ・誰かがそのリンクを一度開いた後にプロフィールを更新すると、
     その行は履歴として残したまま、新しいid・新しいリンクを
     発行する（＝閲覧済みのリンクの中身は勝手に変わらない）。
   ・アクセス制御（本人／初回閲覧者のみ）は他アプリと同様。
   ------------------------------------------------------------
   デプロイ方法:
   1. スプレッドシートを開き「拡張機能 > Apps Script」でこのコードを貼り付ける。
   2. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分
      - アクセスできるユーザー: 全員
      でデプロイする（すでに発行済みの /exec URL を app.js の
      GAS_ENDPOINT に設定済み）。
   ============================================================ */

var SPREADSHEET_ID = '18EsNFzS77rYcL1jGiGJ-JtOCCcyDGO1dVh9FSCUJjg4';
var SHEET_NAME      = 'Shares';
var SCHEMA_VERSION  = 1;

// シートの列番号（1-indexed）
var COL = {
  ID: 1, CIPHER_TEXT: 2, ENCRYPTED_KEY: 3, OWNER_HASH: 4, VIEWER_HASH: 5,
  STATUS: 6, SCHEMA_VERSION: 7, CREATED_AT: 8, UPDATED_AT: 9,
  FIRST_VIEWED_AT: 10, LAST_VIEWED_AT: 11, VIEW_COUNT: 12
};

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ・このアプリにはAnalyticsシートが無いため、handleView側の
     アクセス制御のみ対応する（Analytics同期は不要）。
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';

/* 指定ownerHashの現在の真剣交際ステータスをPartners APIに問い合わせる。
   ・ active: true  → viewerHash が partnerHash と一致する場合のみ閲覧許可
   ・ everPartnered: true（かつ active:false）→ 過去に交際していたが現在は
     パートナー不在（交際終了後など）。本人以外は誰にも見せない。
   ・ 両方 false → 従来通り「初回閲覧者固定」ロジックを使う
   結果は900秒（15分）キャッシュし、Partners API不通時は「everPartnered:false」
   として従来ロジックにフォールバックする（閲覧を過剰にブロックしないため）。
   ※以前は120秒キャッシュだったため、閲覧のたびに別GASへの外部fetchが頻発し、
     それがコールドスタート等と重なって体感速度を落とす主因になっていた。
     交際ステータスはリアルタイム性がそこまで重要ではないため、キャッシュを
     延ばして外部呼び出し頻度を大きく減らす。 */
var PARTNER_STATUS_CACHE_SECONDS = 900;

function getPartnerStatus(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { active: false, everPartnered: false, partnerHash: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || ''
      };
    }
  } catch (err) {
    Logger.log('getPartnerStatus failed: ' + err);
  }
  cache.put(cacheKey, JSON.stringify(result), PARTNER_STATUS_CACHE_SECONDS);
  return result;
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'view') {
      return handleView(e.parameter.id, e.parameter.viewerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'share') {
      return handleShare(body);
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
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
}


/* ------------------------------------------------------------
   共有登録／更新（ハイブリッド方式）
   ・cipherText はクライアント側で AES-GCM 暗号化済みのため、
     このサーバー（および管理者）は復号鍵を一切受け取らない。
   ・id が既存行に存在し、かつ ownerHash が一致する場合：
     - その行がまだ誰にも開かれていない（VIEWER_HASH が空）
       → その行を上書き更新する（同じリンクのまま。従来通り）
     - その行はすでに誰かに開かれている
       → その行は履歴として残し、新しいidを発行して新しい行を
         追加する（＝閲覧済みのリンクの中身は変えない）
   ・id が存在しない場合（初回共有、または新しいidでの共有）：
     → 同じ ownerHash の「未閲覧」の古い行があれば削除したうえで
       新しい行を追加する（1人につき未閲覧の行は常に最大1つ）。
   ・戻り値の id は実際に使われた（更新／追加された）行の id。
     クライアント側は、送信した id と異なる id が返ってきた場合、
     新しいリンクが発行されたと判断して保存し直す必要がある。
   ------------------------------------------------------------ */
function handleShare(body) {
  var id         = body.id;
  var cipherText = body.cipherText;
  var ownerHash  = body.ownerHash;

  if (!id || !cipherText || !ownerHash) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var now = new Date();

    var rowIndex = findRowById(sheet, id);

    if (rowIndex) {
      // 既存行（本人確認のためownerHashを照合）
      var existingOwnerHash  = sheet.getRange(rowIndex, COL.OWNER_HASH).getValue();
      var existingViewerHash = sheet.getRange(rowIndex, COL.VIEWER_HASH).getValue();
      if (existingOwnerHash !== ownerHash) {
        return jsonResponse({ ok: false, reason: 'forbidden' });
      }

      if (!existingViewerHash) {
        // まだ誰にも開かれていない → 同じ行・同じリンクのまま上書き
        sheet.getRange(rowIndex, COL.CIPHER_TEXT).setValue(cipherText);
        sheet.getRange(rowIndex, COL.UPDATED_AT).setValue(now);
        sheet.getRange(rowIndex, COL.STATUS).setValue('active');
        return jsonResponse({ ok: true, id: id });
      }
      // すでに誰かに開かれている → この行はそのまま残し、下で新しい行を作る
    }

    // 新しい行を追加する（id未発見、または既存行が閲覧済みだったため新規発行）。
    // 同じownerHashの「未閲覧」の古い行があれば、その行をそのまま新しい
    // 内容で上書きする（＝1回のsetValuesで完結。deleteRow+appendRowより
    // 大幅に軽い）。無ければ新規行として追加する。未閲覧の行は常に
    // 最大1つになる。
    var newId = rowIndex ? Utilities.getUuid() : id;
    var newRow = [
      newId, cipherText, '', ownerHash, '', 'active', SCHEMA_VERSION,
      now, now, '', '', 0
    ];
    upsertUnviewedRow(sheet, ownerHash, newRow);
    return jsonResponse({ ok: true, id: newId });
  } finally {
    lock.releaseLock();
  }
}

/* 同じ ownerHash の既存行のうち、まだ誰にも開かれていない
   （VIEWER_HASH が空の）行があれば、その行をそのまま上書きする。
   該当行が無ければ新規行として追加する。
   すでに誰かが開いた行は履歴として残すため対象にしない。
   ※通常運用では該当行は0または1件のみのはず（複数残る場合は最初の
     1件だけを上書きし、残りは履歴として残る）。 */
function upsertUnviewedRow(sheet, ownerHash, rowValues) {
  var lastRow = sheet.getLastRow();
  var targetRow = null;
  if (lastRow >= DATA_START_ROW) {
    var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.VIEWER_HASH).getValues();
    for (var i = 0; i < values.length; i++) {
      var rowOwnerHash  = values[i][COL.OWNER_HASH - 1];
      var rowViewerHash = values[i][COL.VIEWER_HASH - 1];
      if (rowOwnerHash === ownerHash && !rowViewerHash) {
        targetRow = DATA_START_ROW + i;
        break;
      }
    }
  }
  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}


/* ------------------------------------------------------------
   閲覧（共有リンクを開いたとき）
   アクセス制御:
   ・本人（ownerHash と一致） → 常に許可
   ・viewerHash が未登録      → この人を初回閲覧者として登録し許可
   ・viewerHash が登録済み    → 一致すれば許可、不一致なら拒否
   ------------------------------------------------------------ */
function handleView(id, viewerHash) {
  if (!id) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!viewerHash) return jsonResponse({ ok: false, reason: 'login_required' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rowIndex = findRowById(sheet, id);
    if (!rowIndex) return jsonResponse({ ok: false, reason: 'not_found' });

    var row = sheet.getRange(rowIndex, 1, 1, COL.VIEW_COUNT).getValues()[0];
    var cipherText         = row[COL.CIPHER_TEXT - 1];
    var ownerHash           = row[COL.OWNER_HASH - 1];
    var existingViewerHash  = row[COL.VIEWER_HASH - 1];
    var status              = row[COL.STATUS - 1];

    if (status !== 'active') {
      return jsonResponse({ ok: false, reason: status === 'active' ? 'not_found' : status });
    }

    var now = new Date();
    var allowed = false;
    var partnerInfo = getPartnerStatus(ownerHash);

    if (viewerHash === ownerHash) {
      allowed = true;
    } else if (partnerInfo.active) {
      allowed = (viewerHash === partnerInfo.partnerHash);
    } else if (partnerInfo.everPartnered) {
      allowed = false;
    } else if (!existingViewerHash) {
      allowed = true;
      sheet.getRange(rowIndex, COL.VIEWER_HASH).setValue(viewerHash);
      sheet.getRange(rowIndex, COL.FIRST_VIEWED_AT).setValue(now);
    } else if (existingViewerHash === viewerHash) {
      allowed = true;
    } else {
      allowed = false;
    }

    if (!allowed) {
      return jsonResponse({ ok: false, reason: (partnerInfo.active || partnerInfo.everPartnered) ? 'partner_locked' : 'forbidden' });
    }

    sheet.getRange(rowIndex, COL.LAST_VIEWED_AT).setValue(now);
    var viewCountCell = sheet.getRange(rowIndex, COL.VIEW_COUNT);
    viewCountCell.setValue((Number(viewCountCell.getValue()) || 0) + 1);

    return jsonResponse({ ok: true, cipherText: cipherText });
  } finally {
    lock.releaseLock();
  }
}

/* id (A列) からデータ行番号を探す。見つからなければ null */
function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var ids = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return DATA_START_ROW + i;
  }
  return null;
}
