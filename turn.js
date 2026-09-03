// ===== TURN credential issuing with live health probes =====
//
// Why this exists: CrossDrop is pure P2P. Two devices on different networks
// (phone on 4G vs. PC on Wi-Fi, CGNAT, symmetric NAT…) can ONLY connect through
// a TURN relay. When the relay silently stops accepting allocations (e.g. the
// provider's monthly quota is used up and it "disables credentials"), the
// browser still receives credentials, gets rejected, and the UI just sits on
// "正在建立 P2P 連線..." forever. This module:
//
//   1. Supports several TURN providers, tried in priority order (env-configured).
//   2. PROBES each provider with a real TURN Allocate (RFC 5766) before handing
//      its credentials to the browser, so a dead/over-quota provider is skipped.
//   3. Reports `turn: false` when no relay works, so the UI can tell the user
//      instead of hanging.
//
// Providers (first working one wins):
//   - Cloudflare Realtime TURN   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
//   - Static TURN (coturn/ExpressTURN/…)  TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL
//   - metered.ca                 METERED_TURN_API_KEY (+ optional METERED_TURN_API_URL)
//   Order can be overridden with TURN_PROVIDERS=cloudflare,static,metered
//   Probing can be disabled with TURN_PROBE=off (not recommended).

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const STUN_FALLBACK = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const FETCH_TIMEOUT_MS = 6000;
const PROBE_TIMEOUT_MS = 5000;
const OK_CACHE_MS = 5 * 60 * 1000;      // re-verify a working provider every 5 min
const FAIL_CACHE_MS = 2 * 60 * 1000;    // retry a failed provider after 2 min
const CF_TTL_SECONDS = 4 * 60 * 60;     // Cloudflare short-lived credential lifetime

// ---------- Provider fetchers ----------

async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchCloudflare() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return null; // not configured
  const r = await fetchWithTimeout(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: CF_TTL_SECONDS }),
    },
  );
  if (!r.ok) throw new Error('cloudflare ' + r.status);
  const data = await r.json();
  let servers = data && data.iceServers;
  if (servers && !Array.isArray(servers)) servers = [servers]; // legacy /credentials/generate shape
  if (!Array.isArray(servers) || !servers.length) throw new Error('cloudflare: empty iceServers');
  return servers;
}

function fetchStatic() {
  const urls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!urls.length) return null; // not configured
  const username = process.env.TURN_USERNAME || '';
  const credential = process.env.TURN_CREDENTIAL || '';
  const servers = [];
  const stun = urls.filter(u => u.startsWith('stun'));
  const turn = urls.filter(u => !u.startsWith('stun'));
  if (stun.length) servers.push({ urls: stun });
  if (turn.length) servers.push({ urls: turn, username, credential });
  return servers;
}

async function fetchMetered() {
  const key = process.env.METERED_TURN_API_KEY;
  if (!key) return null; // not configured
  const base = process.env.METERED_TURN_API_URL || 'https://oldjailab.metered.live/api/v1/turn/credentials';
  const r = await fetchWithTimeout(`${base}?apiKey=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error('metered ' + r.status);
  const servers = await r.json(); // metered returns the iceServers array directly
  if (!Array.isArray(servers) || !servers.length) throw new Error('metered: empty iceServers');
  return servers;
}

const PROVIDERS = {
  cloudflare: fetchCloudflare,
  static: fetchStatic,
  metered: fetchMetered,
};
const DEFAULT_ORDER = ['cloudflare', 'static', 'metered'];

function providerOrder() {
  const env = (process.env.TURN_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);
  const order = env.length ? env : DEFAULT_ORDER;
  return order.filter(n => PROVIDERS[n]);
}

// ---------- Minimal TURN Allocate probe (RFC 5389/5766 over TCP or TLS) ----------

const MAGIC_COOKIE = 0x2112A442;
const ATTR = { USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009, REALM: 0x0014, NONCE: 0x0015, LIFETIME: 0x000d, REQUESTED_TRANSPORT: 0x0019 };
const MSG = { ALLOCATE_REQ: 0x0003, ALLOCATE_OK: 0x0103, ALLOCATE_ERR: 0x0113, REFRESH_REQ: 0x0004 };

function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(pad)]);
}

function buildMessage(type, attrs, integrityKey, tid = crypto.randomBytes(12)) {
  let body = Buffer.concat(attrs);
  if (integrityKey) {
    // MESSAGE-INTEGRITY covers the header with length INCLUDING the MI attribute (24 bytes)
    const hdr = Buffer.alloc(20);
    hdr.writeUInt16BE(type, 0);
    hdr.writeUInt16BE(body.length + 24, 2);
    hdr.writeUInt32BE(MAGIC_COOKIE, 4);
    tid.copy(hdr, 8);
    const mi = crypto.createHmac('sha1', integrityKey).update(Buffer.concat([hdr, body])).digest();
    body = Buffer.concat([body, attr(ATTR.MESSAGE_INTEGRITY, mi)]);
  }
  const hdr = Buffer.alloc(20);
  hdr.writeUInt16BE(type, 0);
  hdr.writeUInt16BE(body.length, 2);
  hdr.writeUInt32BE(MAGIC_COOKIE, 4);
  tid.copy(hdr, 8);
  return Buffer.concat([hdr, body]);
}

function parseMessage(buf) {
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const attrs = new Map();
  let i = 20;
  while (i + 4 <= 20 + len) {
    const t = buf.readUInt16BE(i);
    const l = buf.readUInt16BE(i + 2);
    attrs.set(t, buf.subarray(i + 4, i + 4 + l));
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { type, attrs };
}

function errorInfo(attrs) {
  const e = attrs.get(ATTR.ERROR_CODE);
  if (!e || e.length < 4) return null;
  const code = (e[2] & 0x7) * 100 + e[3];
  return { code, reason: e.subarray(4).toString('utf8') };
}

function parseTurnUrl(url) {
  // turn:host:port?transport=tcp | turns:host:443?transport=tcp
  const m = /^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return {
    scheme,
    host: m[2],
    port: m[3] ? parseInt(m[3], 10) : (scheme === 'turns' ? 5349 : 3478),
    transport: (m[4] || 'udp').toLowerCase(),
  };
}

// Pick the best TURN URL to probe: prefer TCP/TLS (the probe speaks TCP framing).
function pickProbeTarget(iceServers) {
  const candidates = [];
  for (const s of iceServers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      const p = parseTurnUrl(String(u));
      if (p && (p.scheme === 'turns' || p.transport === 'tcp')) {
        candidates.push({ ...p, username: s.username, credential: s.credential, url: u });
      }
    }
  }
  // turns:443 first (most firewall-friendly), then turn:*?transport=tcp
  candidates.sort((a, b) => (b.scheme === 'turns') - (a.scheme === 'turns'));
  return candidates[0] || null;
}

// Read exactly one STUN message from a socket (TCP framing = header + length).
function readStunMessage(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 20) {
        const len = buf.readUInt16BE(2);
        if (buf.length >= 20 + len) {
          cleanup();
          resolve(buf.subarray(0, 20 + len));
        }
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('socket closed')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('probe timeout')); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onErr); socket.off('close', onClose);
    }
    socket.on('data', onData); socket.on('error', onErr); socket.on('close', onClose);
  });
}

function connectSocket(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    const onReady = () => { clearTimeout(timer); resolve(sock); };
    const sock = target.scheme === 'turns'
      ? tls.connect({ host: target.host, port: target.port, servername: target.host }, onReady)
      : net.connect({ host: target.host, port: target.port }, onReady);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Returns { ok: true, url } or { ok: false, url, code, reason }.
async function probeAllocate(iceServers, timeoutMs = PROBE_TIMEOUT_MS) {
  const target = pickProbeTarget(iceServers);
  if (!target) return { ok: false, code: 0, reason: 'no TCP/TLS turn url to probe' };
  let sock;
  try {
    sock = await connectSocket(target, timeoutMs);
    const reqTransport = attr(ATTR.REQUESTED_TRANSPORT, Buffer.from([0x11, 0, 0, 0])); // UDP relay
    // Step 1: unauthenticated Allocate → expect 401 with REALM + NONCE
    sock.write(buildMessage(MSG.ALLOCATE_REQ, [reqTransport]));
    const first = parseMessage(await readStunMessage(sock, timeoutMs));
    if (first.type === MSG.ALLOCATE_OK) return { ok: true, url: target.url }; // open relay (no auth)
    const realm = first.attrs.get(ATTR.REALM);
    const nonce = first.attrs.get(ATTR.NONCE);
    if (!realm || !nonce) {
      const e = errorInfo(first.attrs) || { code: 0, reason: 'no realm/nonce in challenge' };
      return { ok: false, url: target.url, ...e };
    }
    // Step 2: authenticated Allocate (long-term credentials, RFC 5389 §10.2)
    const key = crypto.createHash('md5')
      .update(`${target.username || ''}:${realm.toString('utf8')}:${target.credential || ''}`)
      .digest();
    sock.write(buildMessage(MSG.ALLOCATE_REQ, [
      reqTransport,
      attr(ATTR.USERNAME, Buffer.from(String(target.username || ''), 'utf8')),
      attr(ATTR.REALM, realm),
      attr(ATTR.NONCE, nonce),
    ], key));
    const second = parseMessage(await readStunMessage(sock, timeoutMs));
    if (second.type === MSG.ALLOCATE_OK) {
      // Release the allocation immediately (Refresh with LIFETIME 0); best-effort.
      try {
        sock.write(buildMessage(MSG.REFRESH_REQ, [
          attr(ATTR.LIFETIME, Buffer.from([0, 0, 0, 0])),
          attr(ATTR.USERNAME, Buffer.from(String(target.username || ''), 'utf8')),
          attr(ATTR.REALM, realm),
          attr(ATTR.NONCE, nonce),
        ], key));
      } catch (e) { /* ignore */ }
      return { ok: true, url: target.url };
    }
    const e = errorInfo(second.attrs) || { code: 0, reason: 'unexpected response' };
    return { ok: false, url: target.url, ...e };
  } catch (e) {
    return { ok: false, url: target.url, code: 0, reason: e.message };
  } finally {
    if (sock) sock.destroy();
  }
}

// ---------- Orchestration + cache ----------

const state = new Map(); // provider -> { until, result }

async function evaluateProvider(name) {
  const fetcher = PROVIDERS[name];
  let servers;
  try {
    servers = await fetcher();
  } catch (e) {
    return { ok: false, reason: `credential fetch failed: ${e.message}` };
  }
  if (!servers) return { ok: false, reason: 'not configured', unconfigured: true };
  if ((process.env.TURN_PROBE || '').toLowerCase() === 'off') return { ok: true, servers, probed: false };
  const probe = await probeAllocate(servers);
  if (!probe.ok) return { ok: false, reason: `TURN allocate rejected (${probe.code} ${probe.reason || ''}) via ${probe.url || '?'}` };
  return { ok: true, servers, probed: true, url: probe.url };
}

// Returns { iceServers, turn: boolean, provider: string|null }
let _inflight = null;
function getIceServers() {
  // Coalesce concurrent callers so a burst of page loads triggers ONE probe run.
  if (!_inflight) {
    _inflight = _getIceServers().finally(() => { _inflight = null; });
  }
  return _inflight;
}

async function _getIceServers() {
  const now = Date.now();
  for (const name of providerOrder()) {
    const cached = state.get(name);
    let result;
    if (cached && cached.until > now) {
      result = cached.result;
    } else {
      result = await evaluateProvider(name);
      if (result.unconfigured) { state.set(name, { until: now + OK_CACHE_MS, result }); continue; }
      state.set(name, { until: now + (result.ok ? OK_CACHE_MS : FAIL_CACHE_MS), result });
      if (result.ok) console.log(`[turn] ${name}: OK${result.probed ? ` (allocate verified via ${result.url})` : ''}`);
      else console.error(`[turn] ${name}: ${result.reason}`);
    }
    if (result.ok) return { iceServers: result.servers, turn: true, provider: name };
  }
  return { iceServers: STUN_FALLBACK, turn: false, provider: null };
}

// Diagnostic snapshot (no secrets): which providers are configured / working.
function status() {
  const out = {};
  for (const name of providerOrder()) {
    const s = state.get(name);
    out[name] = s ? (s.result.ok ? 'ok' : (s.result.unconfigured ? 'not configured' : s.result.reason)) : 'not checked yet';
  }
  return out;
}

module.exports = { getIceServers, probeAllocate, status, STUN_FALLBACK, _internals: { buildMessage, parseMessage, attr, ATTR } };
