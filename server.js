const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ===== Security Headers =====
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss: ws:; img-src 'self' blob: data:;");
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== Config =====
const MAX_CLIENTS = 5;
const MAX_MESSAGE_SIZE = 8 * 1024; // 8KB max for signaling messages
const ROOM_CODE_LENGTH = 8; // 8-char alphanumeric (2.8 trillion combinations)
const ROOM_TTL = 60 * 60 * 1000; // 1 hour
const ROOM_EMPTY_TTL = 2 * 60 * 1000; // 2 min after last client leaves
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max 20 join/check attempts per minute per IP

// ===== Rate Limiter =====
const rateLimits = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Clean rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ===== Room Storage =====
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I to avoid confusion
  let code;
  do {
    const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += chars[bytes[i] % chars.length];
    }
  } while (rooms.has(code));
  return code;
}

function generatePeerId() {
  return crypto.randomBytes(8).toString('hex');
}

// Clean up stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.created > ROOM_TTL && room.clients.size === 0) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

// ===== WebSocket Server =====
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
});

wss.on('connection', (ws, req) => {
  ws.roomCode = null;
  ws.peerId = null;
  ws.isAlive = true;
  ws.clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    // Size check (redundant with maxPayload but belt-and-suspenders)
    if (data.length > MAX_MESSAGE_SIZE) return;

    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg.type || typeof msg.type !== 'string') return;

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
        if (!msg.code || typeof msg.code !== 'string') return;
        // Rate limit
        if (isRateLimited(ws.clientIp)) {
          ws.send(JSON.stringify({ type: 'error', message: '操作太頻繁，請稍後再試' }));
          return;
        }
        const code = msg.code.toUpperCase();
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
        const existingPeers = Array.from(room.clients.keys());
        room.clients.set(peerId, ws);
        ws.roomCode = code;
        ws.peerId = peerId;
        ws.send(JSON.stringify({ type: 'room-joined', code, peerId, peers: existingPeers }));
        for (const [id, client] of room.clients) {
          if (id !== peerId && client.readyState === 1) {
            client.send(JSON.stringify({ type: 'peer-joined', peerId, count: room.clients.size }));
          }
        }
        break;
      }

      case 'signal': {
        if (!msg.to || !msg.data) return;
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const target = room.clients.get(msg.to);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({ type: 'signal', from: ws.peerId, data: msg.data }));
        }
        break;
      }

      case 'check-room': {
        if (!msg.code || typeof msg.code !== 'string') return;
        if (isRateLimited(ws.clientIp)) {
          ws.send(JSON.stringify({ type: 'error', message: '操作太頻繁，請稍後再試' }));
          return;
        }
        const code = msg.code.toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'room-not-found', code }));
        } else {
          ws.send(JSON.stringify({ type: 'room-exists', code }));
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
        for (const [id, client] of room.clients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'peer-left', peerId: ws.peerId, count: room.clients.size }));
          }
        }
        if (room.clients.size === 0) {
          room.deleteTimer = setTimeout(() => {
            const r = rooms.get(ws.roomCode);
            if (r && r.clients.size === 0) rooms.delete(ws.roomCode);
          }, ROOM_EMPTY_TTL);
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
