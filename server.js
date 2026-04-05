const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const MAX_CLIENTS = 5;
// Room storage: roomCode -> { clients: Map<peerId, ws>, created, deleteTimer }
const rooms = new Map();
let peerIdCounter = 0;

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function generatePeerId() {
  return 'p' + (++peerIdCounter) + '_' + Math.random().toString(36).slice(2, 6);
}

// Clean up stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.created > 60 * 60 * 1000 && room.clients.size === 0) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.peerId = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const code = generateRoomCode();
        const peerId = generatePeerId();
        const room = { clients: new Map(), created: Date.now(), deleteTimer: null };
        room.clients.set(peerId, ws);
        rooms.set(code, room);
        ws.roomCode = code;
        ws.peerId = peerId;
        ws.send(JSON.stringify({ type: 'room-created', code, peerId }));
        break;
      }

      case 'join-room': {
        const code = msg.code;
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: '房間不存在' }));
          return;
        }
        if (room.deleteTimer) {
          clearTimeout(room.deleteTimer);
          room.deleteTimer = null;
        }
        // Clean stale clients
        for (const [id, client] of room.clients) {
          if (client.readyState !== 1) room.clients.delete(id);
        }
        if (room.clients.size >= MAX_CLIENTS) {
          ws.send(JSON.stringify({ type: 'error', message: `房間已滿 (最多 ${MAX_CLIENTS} 人)` }));
          return;
        }
        const peerId = generatePeerId();
        // Get list of existing peers BEFORE adding new one
        const existingPeers = Array.from(room.clients.keys());

        room.clients.set(peerId, ws);
        ws.roomCode = code;
        ws.peerId = peerId;

        // Tell the new peer: here are existing peers, you are receiver for each
        ws.send(JSON.stringify({
          type: 'room-joined',
          code,
          peerId,
          peers: existingPeers,
        }));

        // Tell each existing peer: a new peer joined, you are initiator
        for (const [id, client] of room.clients) {
          if (id !== peerId && client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'peer-joined',
              peerId,
              count: room.clients.size,
            }));
          }
        }
        break;
      }

      case 'signal': {
        // Route signal to specific peer
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const target = room.clients.get(msg.to);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({
            type: 'signal',
            from: ws.peerId,
            data: msg.data,
          }));
        }
        break;
      }

      case 'check-room': {
        const room = rooms.get(msg.code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'room-not-found', code: msg.code }));
        } else {
          ws.send(JSON.stringify({ type: 'room-exists', code: msg.code }));
        }
        break;
      }

      case 'ping': {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomCode && ws.peerId) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.clients.delete(ws.peerId);
        // Notify remaining peers
        for (const [id, client] of room.clients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'peer-left',
              peerId: ws.peerId,
              count: room.clients.size,
            }));
          }
        }
        if (room.clients.size === 0) {
          room.deleteTimer = setTimeout(() => {
            const r = rooms.get(ws.roomCode);
            if (r && r.clients.size === 0) rooms.delete(ws.roomCode);
          }, 2 * 60 * 1000);
        }
      }
    }
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 45000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CrossDrop 伺服器啟動於 http://localhost:${PORT}`);
});
