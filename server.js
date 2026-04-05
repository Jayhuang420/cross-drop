const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Room storage: roomCode -> { clients: [ws, ws], created: Date, deleteTimer: null }
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

// Clean up stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.created > 30 * 60 * 1000 && room.clients.length === 0) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        const code = generateRoomCode();
        rooms.set(code, { clients: [ws], created: Date.now(), deleteTimer: null });
        ws.roomCode = code;
        ws.send(JSON.stringify({ type: 'room-created', code }));
        break;
      }

      case 'join-room': {
        const code = msg.code;
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: '房間不存在' }));
          return;
        }
        // Cancel any pending delete timer
        if (room.deleteTimer) {
          clearTimeout(room.deleteTimer);
          room.deleteTimer = null;
        }
        if (room.clients.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: '房間已滿' }));
          return;
        }
        room.clients.push(ws);
        ws.roomCode = code;
        ws.send(JSON.stringify({ type: 'room-joined', code }));
        // Notify both peers
        room.clients.forEach(client => {
          client.send(JSON.stringify({ type: 'peer-joined', count: room.clients.length }));
        });
        break;
      }

      case 'signal': {
        // Forward WebRTC signaling to the other peer
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        room.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({ type: 'signal', data: msg.data }));
          }
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.clients = room.clients.filter(c => c !== ws);
        // Notify remaining peer
        room.clients.forEach(client => {
          client.send(JSON.stringify({ type: 'peer-left' }));
        });
        // Don't delete room immediately - give 60s grace period for page navigation reconnects
        if (room.clients.length === 0) {
          room.deleteTimer = setTimeout(() => {
            const r = rooms.get(ws.roomCode);
            if (r && r.clients.length === 0) {
              rooms.delete(ws.roomCode);
            }
          }, 60 * 1000);
        }
      }
    }
  });
});

// WebSocket heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CrossDrop 伺服器啟動於 http://localhost:${PORT}`);
});
