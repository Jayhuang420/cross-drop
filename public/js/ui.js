// ===== Room Page UI Logic =====

// ===== Get room code from URL =====
const params = new URLSearchParams(location.search);
const roomCode = params.get('room');

if (!roomCode) {
  location.href = '/';
}

// ===== DOM Elements =====
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

// ===== Toast =====
function showToast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    toastEl.className = 'toast hidden';
  }, 3000);
}

// ===== Tab Switching =====
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ===== WebSocket + WebRTC Setup =====
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let ws = null;
let peer = null;
let isInitiator = false;
let joinRetries = 0;
const MAX_RETRIES = 5;

let wsKeepAlive = null;

function setConnected(connected) {
  statusDot.classList.toggle('connected', connected);
  connectionText.textContent = connected ? '已連線 - P2P 直連' : '等待對方連線...';
}

function updateConnectionStatus() {
  const webrtcOk = peer && peer.connected;
  const wsOk = ws && ws.readyState === 1;
  statusDot.classList.toggle('connected', webrtcOk);
  if (webrtcOk) {
    connectionText.textContent = '已連線 - P2P 直連';
  } else if (wsOk) {
    connectionText.textContent = '已加入房間，等待對方...';
  } else {
    connectionText.textContent = '重新連線中...';
  }
}

function connectWS() {
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join-room', code: roomCode }));
    // Client-side keep-alive every 30 seconds
    clearInterval(wsKeepAlive);
    wsKeepAlive = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'room-joined':
        joinRetries = 0;
        updateConnectionStatus();
        break;

      case 'peer-joined':
        if (msg.count === 2 && !peer) {
          const initiator = msg.role === 'initiator';
          setupPeer(initiator);
        }
        break;

      case 'signal':
        if (!peer) {
          setupPeer(false);
        }
        peer.handleSignal(msg.data);
        break;

      case 'peer-left':
        // Only show disconnected if WebRTC is also not connected
        if (!peer || !peer.connected) {
          setConnected(false);
          connectionText.textContent = '對方已離開';
          showToast('對方已離開房間', 'error');
        }
        break;

      case 'pong':
        // Server responded to our keep-alive
        break;

      case 'error':
        if (msg.message === '房間不存在' && joinRetries < MAX_RETRIES) {
          joinRetries++;
          connectionText.textContent = `正在重試連線 (${joinRetries}/${MAX_RETRIES})...`;
          setTimeout(() => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'join-room', code: roomCode }));
            }
          }, 1000);
        } else if (msg.message === '房間不存在') {
          // Only redirect if WebRTC is not connected
          if (!peer || !peer.connected) {
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
    // Only show disconnected if WebRTC is also not connected
    if (!peer || !peer.connected) {
      connectionText.textContent = '連線中斷，重新連線中...';
      setConnected(false);
    }
    // Always try to reconnect WebSocket (needed for signaling)
    setTimeout(() => connectWS(), 2000);
  };
}

connectWS();

function setupPeer(initiator) {
  peer = new PeerConnection(
    ws,
    () => updateConnectionStatus(),
    () => updateConnectionStatus(),
    (data) => handleReceivedData(data)
  );
  peer.init(initiator);
}

// ===== Sending Files =====
function sendFiles(files) {
  if (!peer || !peer.connected) {
    showToast('尚未連線，無法傳送', 'error');
    return;
  }

  Array.from(files).forEach(file => {
    const itemId = 'send-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    addTransferItem(itemId, file.name, file.size, 'sending');

    peer.sendFile(file, (loaded, total) => {
      updateTransferProgress(itemId, loaded, total);
    }).then(() => {
      markTransferDone(itemId);
      showToast(`${file.name} 傳送完成`, 'success');
    });
  });
}

// ===== File Input Handlers =====
inputFile.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    sendFiles(e.target.files);
    e.target.value = '';
  }
});

inputCamera.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    sendFiles(e.target.files);
    e.target.value = '';
  }
});

inputGallery.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    sendFiles(e.target.files);
    e.target.value = '';
  }
});

// ===== Drag & Drop =====
dropZoneFile.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZoneFile.classList.add('dragover');
});

dropZoneFile.addEventListener('dragleave', () => {
  dropZoneFile.classList.remove('dragover');
});

dropZoneFile.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZoneFile.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    sendFiles(e.dataTransfer.files);
  }
});

// ===== Send Text =====
btnSendText.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (!text) {
    showToast('請輸入文字', 'error');
    return;
  }
  if (!peer || !peer.connected) {
    showToast('尚未連線，無法傳送', 'error');
    return;
  }
  if (peer.sendText(text)) {
    addSentTextItem(text);
    textInput.value = '';
    showToast('文字已傳送', 'success');
  }
});

textInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    btnSendText.click();
  }
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

function addTransferItem(id, name, size, status) {
  const div = document.createElement('div');
  div.className = 'transfer-item';
  div.id = id;
  div.innerHTML = `
    <span class="transfer-icon">${getFileIcon(name)}</span>
    <div class="transfer-info">
      <div class="transfer-name">${escapeHtml(name)}</div>
      <div class="transfer-meta">
        <span>${formatSize(size)}</span>
      </div>
      <div class="transfer-progress">
        <div class="transfer-progress-bar" style="width: 0%"></div>
      </div>
    </div>
    <span class="transfer-status sending">傳送中</span>
  `;
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
  const status = item.querySelector('.transfer-status');
  status.textContent = '完成';
  status.className = 'transfer-status done';
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
    <span class="transfer-status done">已送出</span>
  `;
  transferItems.prepend(div);
}

// ===== Receiving Data =====
const receivingFiles = {};

function handleReceivedData(data) {
  switch (data.type) {
    case 'text':
      addReceivedText(data.data);
      showToast('收到文字訊息', 'success');
      break;

    case 'file-start':
      receivingFiles[data.name] = {
        name: data.name,
        size: data.size,
        mimeType: data.mimeType,
      };
      const recvId = 'recv-' + Date.now();
      receivingFiles[data.name]._id = recvId;
      addTransferItem(recvId, data.name, data.size, 'receiving');
      // Update label
      const statusEl = document.getElementById(recvId)?.querySelector('.transfer-status');
      if (statusEl) { statusEl.textContent = '接收中'; statusEl.className = 'transfer-status sending'; }
      break;

    case 'file-progress':
      const rf = receivingFiles[data.name];
      if (rf) updateTransferProgress(rf._id, data.loaded, data.total);
      break;

    case 'file-complete':
      addReceivedFile(data);
      const rfDone = receivingFiles[data.name];
      if (rfDone) markTransferDone(rfDone._id);
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
    </div>
  `;
  div.querySelector('.btn-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(e.target.dataset.text).then(() => {
      showToast('已複製到剪貼簿', 'success');
    });
  });
  receivedItems.prepend(div);
}

function addReceivedFile(data) {
  const url = URL.createObjectURL(data.blob);
  const isImage = data.mimeType.startsWith('image/');

  const div = document.createElement('div');
  div.className = 'received-item';

  let preview = '';
  if (isImage) {
    preview = `<img src="${url}" class="received-image-preview" alt="${escapeAttr(data.name)}">`;
  }

  div.innerHTML = `
    ${preview}
    <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;">
      <span style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${getFileIcon(data.name)} ${escapeHtml(data.name)} (${formatSize(data.size)})
      </span>
      <a href="${url}" download="${escapeAttr(data.name)}" class="btn-download">
        &#x2B07;&#xFE0F; 下載
      </a>
    </div>
  `;
  receivedItems.prepend(div);
}

// ===== Utilities =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
