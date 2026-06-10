// ===== Room Page UI Logic =====

const params = new URLSearchParams(location.search);
const roomCode = params.get('room');
if (!roomCode) location.href = '/';

// ===== DOM =====
const statusDot = document.getElementById('status-dot');
const connectionText = document.getElementById('connection-text');
const roomCodeDisplay = document.getElementById('room-code-display');
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');
const dropZoneFile = document.getElementById('drop-zone-file');
const inputFile = document.getElementById('input-file');
const inputCamera = document.getElementById('input-camera');
const inputGallery = document.getElementById('input-gallery');
const textInput = document.getElementById('text-input');
const btnSendText = document.getElementById('btn-send-text');
const transferItems = document.getElementById('transfer-items');
const receivedItems = document.getElementById('received-items');
const toastEl = document.getElementById('toast');

roomCodeDisplay.textContent = roomCode;

// ===== Invite QR (collapsible; shown until a peer connects) =====
const inviteCard = document.getElementById('invite-card');
const inviteCodeEl = document.getElementById('invite-code');
if (inviteCodeEl) inviteCodeEl.textContent = roomCode;
(function renderInviteQR() {
  const c = document.getElementById('qr-container');
  if (!c || typeof QRMini === 'undefined') return;
  try {
    // Dark modules on WHITE background → reliably scannable by phone cameras
    // (inverted/light-on-dark QR codes often fail to scan)
    const canvas = QRMini.toCanvas(`${location.origin}/room.html?room=${roomCode}`, { dark: '#11111B', light: '#FFFFFF', margin: 2 });
    canvas.style.borderRadius = '12px';
    canvas.style.background = '#FFFFFF';
    canvas.style.padding = '10px';
    c.innerHTML = '';
    c.appendChild(canvas);
  } catch (e) { /* QR is optional; ignore render errors */ }
})();
// Collapsible invite area (fold QR + code away)
const inviteToggle = document.getElementById('invite-toggle');
const inviteBody = document.getElementById('invite-body');
if (inviteToggle && inviteBody) {
  inviteToggle.addEventListener('click', () => {
    const collapsed = inviteBody.style.display === 'none';
    inviteBody.style.display = collapsed ? '' : 'none';
    inviteToggle.textContent = collapsed ? '收合 ▲' : '展開 QR ▼';
  });
}

function showToast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => { toastEl.className = 'toast hidden'; }, 3000);
}

// Tabs
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ===== Connection =====
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws = null;
let peerManager = null;
let localPeerId = null;
let wsKeepAlive = null;
let joinRetries = 0;
const MAX_RETRIES = 5;

function updateStatus(connectedCount, totalPeers) {
  const ok = connectedCount > 0;
  statusDot.classList.toggle('connected', ok);
  if (inviteCard) inviteCard.style.display = ok ? 'none' : '';
  if (ok) {
    connectionText.textContent = `已連線 - ${connectedCount} 台裝置 P2P 直連`;
  } else if (totalPeers > 0) {
    connectionText.textContent = '正在建立 P2P 連線...';
  } else {
    connectionText.textContent = '已加入房間，等待其他裝置...';
  }
}

function connectWS() {
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join-room', code: roomCode }));
    clearInterval(wsKeepAlive);
    wsKeepAlive = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'room-joined':
        joinRetries = 0;
        localPeerId = msg.peerId;
        // Create peer manager
        if (peerManager) peerManager.closeAll();
        peerManager = new PeerManager(ws, localPeerId, updateStatus, handleReceivedData);
        // Connect to existing peers in room (we are receiver for each)
        if (msg.peers && msg.peers.length > 0) {
          peerManager.connectToExisting(msg.peers);
        }
        updateStatus(0, msg.peers ? msg.peers.length : 0);
        break;

      case 'peer-joined':
        // A new device joined — we are initiator for this peer
        if (peerManager) {
          peerManager.addNewPeer(msg.peerId);
        }
        break;

      case 'signal':
        // Route signal to the correct peer connection
        if (peerManager) {
          peerManager.handleSignal(msg.from, msg.data);
        }
        break;

      case 'peer-left':
        if (peerManager) {
          peerManager.removePeer(msg.peerId);
        }
        break;

      case 'pong':
        break;

      case 'error':
        if (msg.message === '房間不存在' && joinRetries < MAX_RETRIES) {
          joinRetries++;
          connectionText.textContent = `重試連線 (${joinRetries}/${MAX_RETRIES})...`;
          setTimeout(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'join-room', code: roomCode }));
          }, 1000);
        } else if (msg.message === '房間不存在') {
          if (!peerManager || peerManager.connectedCount === 0) {
            showToast('房間不存在或已過期', 'error');
            setTimeout(() => { location.href = '/'; }, 2000);
          }
        } else {
          showToast(msg.message, 'error');
        }
        break;
    }
  };

  ws.onclose = () => {
    clearInterval(wsKeepAlive);
    if (!peerManager || peerManager.connectedCount === 0) {
      connectionText.textContent = '重新連線中...';
      statusDot.classList.remove('connected');
    }
    setTimeout(() => connectWS(), 2000);
  };
}

connectWS();

// ===== Send Files =====
async function sendFiles(files) {
  if (!peerManager || peerManager.connectedCount === 0) {
    showToast('尚未連線，無法傳送', 'error');
    return;
  }
  // Snapshot now (the <input> may be cleared right after this call) and send
  // files ONE AT A TIME. Sending concurrently interleaves chunks on the single
  // data channel and corrupts the receiver (which assembles one file at a time).
  const list = Array.from(files);
  for (const file of list) {
    const itemId = 'send-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    addTransferItem(itemId, file.name, file.size);
    try {
      await peerManager.sendFileToAll(file, (loaded, total) => {
        updateTransferProgress(itemId, loaded, total);
      });
      markTransferDone(itemId);
      showToast(`${file.name} 傳送完成`, 'success');
    } catch (e) {
      showToast(`${file.name} 傳送失敗`, 'error');
    }
  }
}

inputFile.addEventListener('change', (e) => { if (e.target.files.length) { sendFiles(e.target.files); e.target.value = ''; } });
inputCamera.addEventListener('change', (e) => { if (e.target.files.length) { sendFiles(e.target.files); e.target.value = ''; } });
inputGallery.addEventListener('change', (e) => { if (e.target.files.length) { sendFiles(e.target.files); e.target.value = ''; } });

// Drag & Drop
dropZoneFile.addEventListener('dragover', (e) => { e.preventDefault(); dropZoneFile.classList.add('dragover'); });
dropZoneFile.addEventListener('dragleave', () => { dropZoneFile.classList.remove('dragover'); });
dropZoneFile.addEventListener('drop', (e) => { e.preventDefault(); dropZoneFile.classList.remove('dragover'); if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files); });

// Send Text
btnSendText.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (!text) { showToast('請輸入文字', 'error'); return; }
  if (!peerManager || peerManager.connectedCount === 0) { showToast('尚未連線，無法傳送', 'error'); return; }
  if (peerManager.sendTextToAll(text)) {
    addSentTextItem(text);
    textInput.value = '';
    showToast('文字已傳送', 'success');
  }
});

textInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') btnSendText.click();
});

// ===== Transfer UI =====
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    jpg: '\u{1F5BC}\uFE0F', jpeg: '\u{1F5BC}\uFE0F', png: '\u{1F5BC}\uFE0F', gif: '\u{1F5BC}\uFE0F', webp: '\u{1F5BC}\uFE0F', svg: '\u{1F5BC}\uFE0F',
    mp4: '\u{1F3AC}', mov: '\u{1F3AC}', avi: '\u{1F3AC}', mkv: '\u{1F3AC}',
    mp3: '\u{1F3B5}', wav: '\u{1F3B5}', flac: '\u{1F3B5}', aac: '\u{1F3B5}',
    pdf: '\u{1F4C4}', doc: '\u{1F4C4}', docx: '\u{1F4C4}', txt: '\u{1F4C4}',
    zip: '\u{1F4E6}', rar: '\u{1F4E6}', '7z': '\u{1F4E6}',
  };
  return icons[ext] || '\u{1F4CE}';
}

function addTransferItem(id, name, size) {
  const div = document.createElement('div');
  div.className = 'transfer-item';
  div.id = id;
  div.innerHTML = `
    <span class="transfer-icon">${getFileIcon(name)}</span>
    <div class="transfer-info">
      <div class="transfer-name">${escapeHtml(name)}</div>
      <div class="transfer-meta"><span>${formatSize(size)}</span></div>
      <div class="transfer-progress"><div class="transfer-progress-bar" style="width:0%"></div></div>
    </div>
    <span class="transfer-status sending">傳送中</span>`;
  transferItems.prepend(div);
}

function updateTransferProgress(id, loaded, total) {
  const item = document.getElementById(id);
  if (!item) return;
  const pct = Math.round((loaded / total) * 100);
  item.querySelector('.transfer-progress-bar').style.width = pct + '%';
  item.querySelector('.transfer-status').textContent = pct + '%';
}

function markTransferDone(id) {
  const item = document.getElementById(id);
  if (!item) return;
  item.querySelector('.transfer-progress-bar').style.width = '100%';
  const s = item.querySelector('.transfer-status');
  s.textContent = '完成';
  s.className = 'transfer-status done';
}

function addSentTextItem(text) {
  const div = document.createElement('div');
  div.className = 'transfer-item';
  div.innerHTML = `
    <span class="transfer-icon">\u{1F4AC}</span>
    <div class="transfer-info">
      <div class="transfer-name">${escapeHtml(text.slice(0, 50))}${text.length > 50 ? '...' : ''}</div>
      <div class="transfer-meta"><span>文字訊息</span></div>
    </div>
    <span class="transfer-status done">已送出</span>`;
  transferItems.prepend(div);
}

// ===== Receive =====
const receivingFiles = {};

function handleReceivedData(data) {
  switch (data.type) {
    case 'text':
      addReceivedText(data.data);
      showToast('收到文字訊息', 'success');
      break;
    case 'file-start':
      receivingFiles[data.name] = { name: data.name, size: data.size, mimeType: data.mimeType };
      const recvId = 'recv-' + Date.now();
      receivingFiles[data.name]._id = recvId;
      addTransferItem(recvId, data.name, data.size);
      const el = document.getElementById(recvId)?.querySelector('.transfer-status');
      if (el) { el.textContent = '接收中'; el.className = 'transfer-status sending'; }
      break;
    case 'file-progress':
      const rf = receivingFiles[data.name];
      if (rf) updateTransferProgress(rf._id, data.loaded, data.total);
      break;
    case 'file-complete':
      addReceivedFile(data);
      const done = receivingFiles[data.name];
      if (done) markTransferDone(done._id);
      delete receivingFiles[data.name];
      showToast(`收到檔案: ${data.name}`, 'success');
      break;
  }
}

function addReceivedText(text) {
  const div = document.createElement('div');
  div.className = 'received-item';
  div.innerHTML = `
    <div class="received-text">${escapeHtml(text)}</div>
    <div class="received-text-actions">
      <button class="btn btn-secondary btn-small btn-copy" data-text="${escapeAttr(text)}">複製</button>
    </div>`;
  div.querySelector('.btn-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(e.target.dataset.text).then(() => showToast('已複製到剪貼簿', 'success'));
  });
  receivedItems.prepend(div);
}

function addReceivedFile(data) {
  const url = URL.createObjectURL(data.blob);
  const mime = data.mimeType || '';
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const div = document.createElement('div');
  div.className = 'received-item';
  div.innerHTML = `
    ${isImage ? `<img src="${url}" class="received-image-preview" alt="${escapeAttr(data.name)}">` : ''}
    <div class="received-file-row">
      <span class="received-file-name">${getFileIcon(data.name)} ${escapeHtml(data.name)} (${formatSize(data.size)})</span>
      <span class="received-file-actions">
        ${(isImage || isVideo) ? `<button class="btn-save-album" type="button">&#x1F4F2; 存到相簿</button>` : ''}
        <a href="${url}" download="${escapeAttr(data.name)}" class="btn-download">&#x2B07;&#xFE0F; 下載</a>
      </span>
    </div>`;
  // Save photo/video into the phone's album via the Web Share sheet (iOS: 儲存影像/影片).
  const saveBtn = div.querySelector('.btn-save-album');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      try {
        const file = new File([data.blob], data.name, { type: mime || 'application/octet-stream' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] }); // share sheet → save to Photos/相簿
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the share sheet
      }
      // Fallback (older iOS / no file-share): open media so user can long-press → 加入照片
      window.open(url, '_blank');
    });
  }
  receivedItems.prepend(div);
}

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function escapeAttr(str) { return str.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
