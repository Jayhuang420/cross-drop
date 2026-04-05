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
    if (now - room.created > 60 * 60 * 1000 && room.clients.length === 0) {
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
        // Remove stale clients (closed connections still in array)
        room.clients = room.clients.filter(c => c.readyState === 1);
        if (room.clients.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: '房間已滿' }));
          return;
        }
        room.clients.push(ws);
        ws.roomCode = code;
        ws.send(JSON.stringify({ type: 'room-joined', code }));
        // Notify peers with role assignment
        if (room.clients.length === 2) {
          // First client is initiator, second is receiver
          const [first, second] = room.clients;
          if (first.readyState === 1) {
            first.send(JSON.stringify({ type: 'peer-joined', count: 2, role: 'initiator' }));
          }
          if (second.readyState === 1) {
            second.send(JSON.stringify({ type: 'peer-joined', count: 2, role: 'receiver' }));
          }
        }
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        room.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({ type: 'signal', data: msg.data }));
          }
        });
        break;
      }

      // Check if room exists (without joining)
      case 'check-room': {
        const code = msg.code;
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'room-not-found', code }));
        } else {
          ws.send(JSON.stringify({ type: 'room-exists', code }));
        }
        break;
      }

      // Client-side keep-alive
      case 'ping': {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: 'pong' }));
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
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'peer-left' }));
          }
        });
        // Keep room alive for 5 minutes for reconnection
        if (room.clients.length === 0) {
          room.deleteTimer = setTimeout(() => {
            const r = rooms.get(ws.roomCode);
            if (r && r.clients.length === 0) {
              rooms.delete(ws.roomCode);
            }
          }, 5 * 60 * 1000);
        }
      }
    }
  });
});

// Server-side heartbeat - check every 2 minutes, generous timeout
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 120000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CrossDrop 伺服器啟動於 http://localhost:${PORT}`);
});
