# crossdrop-turn (Cloudflare Worker)

Keeps the Cloudflare Realtime TURN API token **off the app host**. The CrossDrop
server calls `GET /ice-servers` on this Worker and receives short-lived ICE
credentials; the Worker holds the long-lived token as a Worker Secret.

## Deploy

```bash
cd turn-worker
npx wrangler login          # one-time OAuth in the browser
npx wrangler deploy
```

## Secrets (set once, never in git)

Dashboard → Workers & Pages → crossdrop-turn → Settings → Variables and Secrets:

| Name | Type | Value |
|------|------|-------|
| `TURN_API_TOKEN` | Secret | the API Token shown when the TURN key was created |
| `PROXY_KEY` | Secret (optional) | extra shared key the server must send as `X-Proxy-Key` |

## Lock down

1. Find the app host's egress IP: `curl https://<worker>.workers.dev/whoami` from the host,
   or read it from `/api/turn-status` on the app (the 403 body echoes the caller IP).
2. Put it in `ALLOWED_IPS` in `wrangler.toml` and redeploy.

## App side

`turn.js` provider `proxy` (first in the default order) reads:

- `TURN_PROXY_URL` — defaults to this Worker's `/ice-servers` URL
- `TURN_PROXY_KEY` — only if `PROXY_KEY` is set on the Worker
