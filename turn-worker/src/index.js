// CrossDrop TURN credential proxy — runs on Cloudflare Workers.
//
// Why: the Cloudflare Realtime TURN API token must NOT live on the app host
// (Zeabur env vars leaked once already). This Worker keeps the token as a
// Worker Secret (write-only, never readable from the dashboard) and hands the
// CrossDrop server short-lived ICE credentials on request.
//
// Protection (no secret needed on the app host):
//   - ALLOWED_IPS  (var)  comma-separated caller IPs allowed to mint credentials
//   - PROXY_KEY    (secret, optional) if set, caller must send  X-Proxy-Key
//
// Config:
//   TURN_KEY_ID     (var)     Cloudflare TURN key id
//   TURN_API_TOKEN  (secret)  Cloudflare TURN key API token   ← set in dashboard, never in code
//   CRED_TTL        (var)     credential lifetime in seconds (default 14400 = 4 h)

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || '';

    // Anyone may ask "who am I" — used once to learn the app host's egress IP.
    if (url.pathname === '/whoami') return json({ ip });

    if (url.pathname !== '/ice-servers') return json({ error: 'not found' }, 404);
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method' }, 405);

    const allowed = String(env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(ip)) return json({ error: 'forbidden', ip }, 403);
    if (env.PROXY_KEY && request.headers.get('x-proxy-key') !== env.PROXY_KEY) return json({ error: 'forbidden', ip }, 403);

    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ error: 'worker not configured (TURN_KEY_ID / TURN_API_TOKEN)', ip }, 500);

    const ttl = Math.max(600, parseInt(env.CRED_TTL || '14400', 10) || 14400);
    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502);
    const data = await upstream.json();
    let servers = data && data.iceServers;
    if (servers && !Array.isArray(servers)) servers = [servers];
    if (!Array.isArray(servers) || !servers.length) return json({ error: 'upstream returned no iceServers' }, 502);
    return json({ iceServers: servers, ttl });
  },
};
