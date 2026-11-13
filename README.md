# browser-renderer

Tiny puppeteer-backed HTTP service for rendering JavaScript pages to HTML. Designed for crawler / scraper use cases (Sitepulse broken-links checks, etc.).

## Endpoints

### `POST /content`

Renders a URL and returns the post-JS HTML.

```bash
curl -X POST http://localhost:3000/content \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

Response:

```json
{ "content": "<html>...</html>" }
```

Body params:

| Field       | Default         | Description                                                       |
|-------------|-----------------|-------------------------------------------------------------------|
| `url`       | (required)      | URL to render                                                     |
| `waitUntil` | `networkidle2`  | Puppeteer goto wait condition                                     |
| `timeout`   | `30000`         | Navigation timeout (ms), capped at 60000                          |
| `userAgent` | (none)          | Override the User-Agent header                                    |

### `POST /lighthouse`

Runs Lighthouse with the standard simulated desktop profile and a fresh browser. Returns the Lighthouse result with diagnostics, excluding screenshot blobs.

```bash
curl -X POST http://localhost:3000/lighthouse \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

Response:

```json
{ "lighthouseResult": { "...": "..." }, "durationMs": 12345, "source": "browser-renderer" }
```

### `GET /healthz`

Returns 200 when the service is ready, including before the first render; returns 503 during shutdown or when `RENDER_TOKEN` is missing. Includes `browserConnected`, `active`, `renders`, and `uptimeMs`.

## Performance defaults

- Shared Chrome instance for `/content`, fresh page per request; Lighthouse uses a dedicated browser per audit so timeout cleanup cannot interrupt HTML renders
- Browser leases prevent Chrome recycling while a request is opening or using a page
- Auto-recycle Chrome after `BROWSER_MAX_RENDERS` (default 1000) or `BROWSER_MAX_AGE_MS` (default 1 hour) — prevents memory leaks
- Aborts image / media / font / stylesheet requests by default — link extraction doesn't need them, ~3–5× faster
- `MAX_CONCURRENT` semaphore returns 503 instead of OOMing when overloaded
- Graceful SIGTERM: drains in-flight requests through the configured audit timeout before closing the browser

## Environment variables

See `.env.example`. Copy to `.env` before booting.

| Var                     | Default     | Description                                                |
|-------------------------|-------------|------------------------------------------------------------|
| `RENDER_TOKEN`          | (unset)     | Required bearer token; requests fail if it is unset. |
| `MAX_CONCURRENT`        | `40`        | Hard cap on parallel renders                               |
| `NAV_TIMEOUT_MS`        | `30000`     | Default goto timeout                                       |
| `LIGHTHOUSE_TIMEOUT_MS` | `120000`    | Lighthouse runner timeout                                  |
| `MAX_RESPONSE_BYTES` | `5500000` | Maximum rendered HTML JSON response size |
| `BROWSER_MAX_RENDERS`   | `1000`      | Recycle Chrome after N renders                             |
| `BROWSER_MAX_AGE_MS`    | `3600000`   | Recycle Chrome after N ms uptime                           |

## Local dev

```bash
cp .env.example .env
# Set RENDER_TOKEN in .env before starting.
docker compose up --build
curl http://localhost:3000/healthz
```

## Deploy via Ploi (Docker server)

1. Push this repo to GitHub.
2. In Ploi, create the site on your Docker server pointing at this repo.
3. Set environment variables in Ploi's UI (or paste an `.env`):
   - `RENDER_TOKEN=<long random>`
   - `MAX_CONCURRENT=40` (tune per box size — see sizing below)
4. Enable auto-deploy on push.
5. Ploi runs `docker compose up -d --build` on each deploy.

### Locking down access

Render service must NOT be public. Two options:

**Option A — Hetzner private network (recommended):**
- Attach Sitepulse app server + render server to the same Hetzner private network
- Change the port binding from `127.0.0.1:3000:3000` to the renderer's private IP, such as `10.0.0.2:3000:3000`
- In Ploi → Server → Firewall: allow port `3000` only from the app server's private IP
- Sitepulse calls `http://<render-private-ip>:3000`

**Option B — Cloudflare Tunnel:**
- Install `cloudflared` on the render box, route `render.yourdomain.com` → `localhost:3000`
- Block port 3000 in Ploi firewall entirely
- Add Cloudflare Access policy on the hostname for double auth

Enable the optional tunnel with `docker compose --profile tunnel up -d --build`. Otherwise, proxy the renderer's loopback port through Ploi.

Either way: `RENDER_TOKEN` is **mandatory** as second factor.

## Box sizing (Hetzner reference)

| Plan    | vCPU / RAM   | Approx concurrent renders | Cost/mo |
|---------|--------------|---------------------------|---------|
| CPX31   | 4 shared / 8GB  | ~15                    | €15     |
| CCX23   | 8 dedicated / 32GB | ~50                 | €29     |
| CCX33   | 16 dedicated / 64GB | ~120                | €57     |

Shared CPU plans (CX, CPX) work for low volume but throttle under sustained load. **Dedicated (CCX) recommended for production.**

Set `MAX_CONCURRENT` to ~80% of theoretical headroom. Leave room for spikes.

## Load testing

```bash
RENDER_URL=http://localhost:3000 \
RENDER_TOKEN=your-token \
TARGET_URL=https://example.com \
DURATION=30 \
CONCURRENCY=20 \
npm run loadtest
```

Watch:
- `non2xx` — should be near zero (503s = you exceeded `MAX_CONCURRENT`)
- p99 latency — should be under your `NAV_TIMEOUT_MS`
- `docker stats` in another terminal — memory/CPU under load

## Scaling out

When one box runs out of headroom:
1. **Vertical first** — bump CCX23 → CCX33 (€29 → €57 doubles capacity)
2. **Horizontal** — second box, simple round-robin via Caddy / HAProxy on the app side
3. **Geo-split** — render box per region, route by site TLD or check region
