// ===== WebSocket Connection =====
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${location.host}`);

// ===== DOM Elements =====
const homeScreen = document.getElementById('home-screen');
const waitingScreen = document.getElementById('waiting-screen');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const btnCancel = document.getElementById('btn-cancel');
const inputCode = document.getElementById('input-code');
const displayCode = document.getElementById('display-code');
const qrContainer = document.getElementById('qr-container');
const toastEl = document.getElementById('toast');

let currentRoomCode = null;

// ===== QR Code (using embedded QRMini) =====
function generateQR(text, container) {
  const canvas = QRMini.toCanvas(text, {
    dark: '#EEEEF0',
    light: '#1A1A2E',
    margin: 2,
  });
  canvas.style.borderRadius = '12px';
  canvas.style.border = '3px solid #2A2A45';
  container.innerHTML = '';
  container.appendChild(canvas);
}

// ===== Toast =====
function showToast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    toastEl.className = 'toast hidden';
  }, 3000);
}

// ===== Screen Navigation =====
function showScreen(screen) {
  homeScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  screen.classList.remove('hidden');
}

// ===== WebSocket Handlers =====
ws.onopen = () => {
  // Check if URL has room code (from QR scan)
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('room');
  if (joinCode) {
    ws.send(JSON.stringify({ type: 'join-room', code: joinCode }));
  }
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'room-created':
      currentRoomCode = msg.code;
      displayCode.textContent = msg.code;
      showScreen(waitingScreen);
      // Generate QR Code - points directly to room.html
      const roomUrl = `${location.origin}/room.html?room=${msg.code}`;
      generateQR(roomUrl, qrContainer);
      // Creator goes to room.html immediately (room persists on server)
      setTimeout(() => {
        location.href = `/room.html?room=${msg.code}`;
      }, 500);
      break;

    case 'room-joined':
      currentRoomCode = msg.code;
      // Redirect to room page
      location.href = `/room.html?room=${msg.code}`;
      break;

    case 'peer-joined':
      // Already on waiting screen or about to redirect
      break;

    case 'error':
      showToast(msg.message, 'error');
      break;
  }
};

ws.onclose = () => {
  showToast('連線中斷，請重新整理頁面', 'error');
};

// ===== Event Listeners =====
btnCreate.addEventListener('click', () => {
  btnCreate.disabled = true;
  ws.send(JSON.stringify({ type: 'create-room' }));
});

btnJoin.addEventListener('click', () => {
  const code = inputCode.value.trim();
  if (code.length !== 6) {
    showToast('請輸入 6 位數房間代碼', 'error');
    return;
  }
  ws.send(JSON.stringify({ type: 'join-room', code }));
});

btnCancel.addEventListener('click', () => {
  location.reload();
});

// Auto-focus and format code input
inputCode.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});
