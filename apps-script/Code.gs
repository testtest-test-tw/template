/**
 * 選屋系統 · Google Drive 文件歸檔
 *
 * 安裝方式（每個個案做一次）：
 * 1. 在公司的 Google Drive（建議用共用雲端硬碟）建立資料夾，例如「清水段選屋文件」
 *    打開資料夾，網址最後那串就是資料夾 ID：https://drive.google.com/drive/folders/【這一串】
 * 2. 到 script.google.com → 新專案 → 把這個檔案內容整個貼上
 * 3. 左邊齒輪「專案設定」→ 最下面「指令碼屬性」新增三個：
 *      ROOT_FOLDER_ID     = 步驟 1 的資料夾 ID
 *      SUPABASE_URL       = https://xxxx.supabase.co
 *      SUPABASE_ANON_KEY  = Supabase 的 anon public key
 * 4. 右上「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *      執行身分：我
 *      誰可以存取：任何人
 *    （只有登入後台的選屋人員才能上傳：每次上傳都會向 Supabase 確認對方身分）
 * 5. 複製「網頁應用程式網址」，貼到後台「案件設定 → 文件 → Google Drive 上傳網址」
 */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var who = checkStaff_(body.token);
    if (!who) return json_({ ok: false, error: '沒有上傳權限，請重新登入後台' });

    var name = String(body.fileName || '').replace(/[\\\/:*?"<>|]/g, '_');
    var folderName = String(body.folder || '未分類').replace(/[\\\/:*?"<>|]/g, '_');
    if (!name || !body.data) return json_({ ok: false, error: '缺少檔案內容' });

    var root = DriveApp.getFolderById(prop_('ROOT_FOLDER_ID'));
    var folder = childFolder_(root, folderName);

    // 同名檔案已存在：舊檔改名保留，不覆蓋
    var old = folder.getFilesByName(name);
    while (old.hasNext()) {
      var f = old.next();
      f.setName(name.replace(/\.pdf$/i, '') + '_舊版_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.pdf');
    }
    var blob = Utilities.newBlob(Utilities.base64Decode(body.data), 'application/pdf', name);
    var file = folder.createFile(blob);
    file.setDescription('上傳者：' + who + '　' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm'));
    return json_({ ok: true, id: file.getId(), url: file.getUrl(), folder: folder.getName() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: '選屋系統文件歸檔', time: new Date().toISOString() });
}

// 用登入後台時拿到的憑證，向 Supabase 確認是選屋人員（staff 名單內）
function checkStaff_(token) {
  if (!token) return null;
  var url = prop_('SUPABASE_URL'), key = prop_('SUPABASE_ANON_KEY');
  var res = UrlFetchApp.fetch(url + '/rest/v1/rpc/is_staff', {
    method: 'post', contentType: 'application/json', payload: '{}', muteHttpExceptions: true,
    headers: { apikey: key, Authorization: 'Bearer ' + token }
  });
  if (res.getResponseCode() !== 200 || res.getContentText().trim() !== 'true') return null;
  var u = UrlFetchApp.fetch(url + '/auth/v1/user', { muteHttpExceptions: true, headers: { apikey: key, Authorization: 'Bearer ' + token } });
  try { return JSON.parse(u.getContentText()).email || 'staff'; } catch (e) { return 'staff'; }
}

function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function prop_(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('尚未設定指令碼屬性 ' + k);
  return v;
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
