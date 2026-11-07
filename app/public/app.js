let files = [];
let allSelected = false;

// DB由来の値（ファイル名など）を innerHTML に埋め込む前に必ずエスケープする。
// 利用者が入力した文字列をそのまま HTML にすると、スクリプトを仕込まれる（XSS）
function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ファイル一覧を取得
async function loadFiles() {
  const fileListDiv = document.getElementById('fileList');
  fileListDiv.innerHTML = '<div class="empty-message">読み込み中...</div>';
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    files = data.files;
    if (files.length === 0) {
      fileListDiv.innerHTML = '<div class="empty-message">ファイルがありません。上のフォームからアップロードしてください。</div>';
    } else {
      fileListDiv.innerHTML = files.map((file, i) => `
        <div class="file-item">
          <input type="checkbox" id="file-${i}" data-id="${esc(file.id)}" onchange="updateButtons()">
          <div class="file-info">
            <div class="file-name">${esc(file.originalName)}${file.hasThumbnail ? '<span class="thumbnail-badge">サムネイル済</span>' : ''}</div>
            <div class="file-meta">${formatSize(file.size)} | ${esc(file.s3Key)}</div>
          </div>
          <div class="file-actions">
            <button class="debug" data-thumbnail-file-id="${esc(file.id)}">サムネイル2回生成</button>
          </div>
        </div>
      `).join('');
    }
    updateButtons();
  } catch (err) {
    fileListDiv.innerHTML = '<div class="empty-message">エラー: ' + esc(err.message) + '</div>';
  }
}

// アーカイブ一覧を取得
async function loadArchives() {
  const listDiv = document.getElementById('archiveList');
  listDiv.innerHTML = '<div class="empty-message">読み込み中...</div>';
  try {
    const res = await fetch('/api/archives');
    const data = await res.json();
    if (data.archives.length === 0) {
      listDiv.innerHTML = '<div class="empty-message">アーカイブがありません。</div>';
    } else {
      listDiv.innerHTML = data.archives.map(a => `
        <div class="archive-item">
          <strong>${esc(a.s3Key)}</strong>
          <span class="status ${esc(a.status)}">${esc(a.status)}</span>
          <div style="font-size:0.85em;color:#666;margin-top:5px;">
            ファイル数: ${esc(a.fileCount)} | サイズ: ${a.size ? formatSize(a.size) : '-'}
            ${a.completedAt ? ' | 完了: ' + esc(new Date(a.completedAt).toLocaleString()) : ''}
            ${a.errorMessage ? '<br><span style="color:red;">エラー: ' + esc(a.errorMessage) + '</span>' : ''}
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    listDiv.innerHTML = '<div class="empty-message">エラー: ' + esc(err.message) + '</div>';
  }
}

function formatSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function toggleSelectAll() {
  allSelected = !allSelected;
  document.querySelectorAll('#fileList input[type="checkbox"]').forEach(cb => cb.checked = allSelected);
  updateButtons();
}

function updateButtons() {
  const checked = document.querySelectorAll('#fileList input[type="checkbox"]:checked').length;
  document.getElementById('createArchiveBtn').disabled = checked === 0;
  document.getElementById('debugArchiveBtn').disabled = checked === 0;
}

function getSelectedFileIds() {
  return Array.from(document.querySelectorAll('#fileList input[type="checkbox"]:checked')).map(cb => cb.dataset.id);
}

// 通常のアーカイブ作成
async function createArchive() {
  const resultDiv = document.getElementById('archiveResult');
  const fileIds = getSelectedFileIds();
  if (fileIds.length === 0) { showError(resultDiv, 'ファイルを選択してください'); return; }
  try {
    const res = await fetch('/api/archives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showSuccess(resultDiv, 'ジョブを投入しました (JobID: ' + data.jobId + ', Archive: ' + data.archive.s3Key + ')');
    clearSelection();
    loadArchives();
  } catch (err) { showError(resultDiv, err.message); }
}

// デバッグ: 2件同時投入（パターン2）
async function createArchiveDebug() {
  const resultDiv = document.getElementById('archiveResult');
  const fileIds = getSelectedFileIds();
  if (fileIds.length === 0) { showError(resultDiv, 'ファイルを選択してください'); return; }
  try {
    const res = await fetch('/api/archives/debug-duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showSuccess(resultDiv, '2件のジョブを同時投入しました (JobIDs: ' + data.jobIds.join(', ') + ', Archive: ' + data.archive.s3Key + ')');
    clearSelection();
    loadArchives();
  } catch (err) { showError(resultDiv, err.message); }
}

// デバッグ: サムネイル2回生成（パターン1）
async function generateThumbnailDebug(fileId) {
  const resultDiv = document.getElementById('archiveResult');
  try {
    const [res1, res2] = await Promise.all([
      fetch('/api/files/' + fileId + '/thumbnail', { method: 'POST' }),
      fetch('/api/files/' + fileId + '/thumbnail', { method: 'POST' })
    ]);
    const [data1, data2] = await Promise.all([res1.json(), res2.json()]);
    if (data1.error) throw new Error(data1.error);
    showSuccess(resultDiv, 'サムネイル生成ジョブを2件投入しました (JobIDs: ' + data1.jobId + ', ' + data2.jobId + ')');
    setTimeout(loadFiles, 2000);
  } catch (err) { showError(resultDiv, err.message); }
}

function clearSelection() {
  document.querySelectorAll('#fileList input[type="checkbox"]').forEach(cb => cb.checked = false);
  allSelected = false;
  updateButtons();
}

function showSuccess(div, msg) { div.textContent = '✓ ' + msg; div.className = 'result'; div.style.display = 'block'; }
function showError(div, msg) { div.textContent = '✗ ' + msg; div.className = 'result error'; div.style.display = 'block'; }

// ファイルアップロード
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('file').files[0];
  const resultDiv = document.getElementById('uploadResult');
  try {
    // 1. 署名付きURL取得
    const res1 = await fetch('/api/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, contentType: file.type }) });
    const { uploadUrl, key } = await res1.json();
    // 2. S3に直接アップロード
    await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
    // 3. DB登録（自動でサムネイル生成ジョブ投入）。サイズや Content-Type は
    //    サーバ側が S3 の実物から取得するため送らない
    const res2 = await fetch('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ s3Key: key, originalName: file.name }) });
    const data = await res2.json();
    showSuccess(resultDiv, 'アップロード完了 (Key: ' + key + ', サムネイルJobID: ' + data.thumbnailJobId + ')');
    document.getElementById('file').value = '';
    loadFiles();
  } catch (err) { showError(resultDiv, err.message); }
});

// 「サムネイル2回生成」ボタンは、値を onclick 属性に埋め込まず
// data 属性 + イベント委譲で処理する（属性への文字列埋め込みは事故のもと）
document.getElementById('fileList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-thumbnail-file-id]');
  if (btn) generateThumbnailDebug(btn.dataset.thumbnailFileId);
});

// 初期読み込み
loadFiles();
loadArchives();
