// ============================================================
//  ARKA Intelligence Center — Relay Server
//  Deploy en Railway: railway up
//  Variables requeridas: RELAY_SHARED_SECRET, OPENSKY_CLIENT_ID,
//  OPENSKY_CLIENT_SECRET, AISSTREAM_API_KEY
// ============================================================
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET || '';

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({
  origin: [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https:\/\/.*\.vercel\.app$/,
    /^https:\/\/.*\.up\.railway\.app$/,
  ],
  methods: ['GET', 'OPTIONS'],
}));

// ── Auth ──────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!RELAY_SECRET) return next();
  const key = req.headers['x-relay-key'] ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (key !== RELAY_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Fetch helper ─────────────────────────────────────────────
async function proxy(url, headers = {}, res, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ARKARelay/1.0', Accept: 'application/json, */*', ...headers },
      signal: ctrl.signal,
    });
    const body = await r.text();
    const ct = r.headers.get('content-type') || 'application/json';
    res.status(r.status).set('Content-Type', ct).send(body);
  } catch (err) {
    res.status(err.name === 'AbortError' ? 504 : 502).json({
      error: err.name === 'AbortError' ? 'Upstream timeout' : 'Upstream error',
      details: err.message,
    });
  } finally {
    clearTimeout(t);
  }
}

// ── Health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Polymarket ───────────────────────────────────────────────
app.get('/polymarket', auth, async (req, res) => {
  const endpoint = req.query.endpoint || 'markets';
  const params = new URLSearchParams(req.query);
  params.delete('endpoint');
  await proxy(
    `https://gamma-api.polymarket.com/${endpoint}?${params}`,
    { Accept: 'application/json' },
    res
  );
});

// ── OpenSky OAuth2 ───────────────────────────────────────────
let openskyToken = null;
let openskyTokenExp = 0;

async function getOpenSkyToken() {
  if (openskyToken && Date.now() < openskyTokenExp - 60000) return openskyToken;
  const { OPENSKY_CLIENT_ID: id, OPENSKY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('OpenSky credentials not configured');
  const r = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret,
      }),
    }
  );
  if (!r.ok) throw new Error(`OpenSky auth failed: ${r.status}`);
  const data = await r.json();
  openskyToken = data.access_token;
  openskyTokenExp = Date.now() + data.expires_in * 1000;
  return openskyToken;
}

app.get('/opensky', auth, async (req, res) => {
  try {
    const token = await getOpenSkyToken();
    const params = new URLSearchParams(req.query);
    await proxy(
      `https://opensky-network.org/api/states/all?${params}`,
      { Authorization: `Bearer ${token}` },
      res
    );
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ── AISStream WebSocket relay ─────────────────────────────────
// Los clientes llaman GET /ais?bbox=lat_min,lon_min,lat_max,lon_max
// El relay hace la petición REST a AISStream API
app.get('/ais', auth, async (req, res) => {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) return res.status(503).json({ error: 'AISStream not configured' });
  const { lat_min = 0, lon_min = 0, lat_max = 90, lon_max = 180 } = req.query;
  // AISStream REST endpoint para snapshots
  await proxy(
    `https://api.aisstream.io/v0/vessels?lat_min=${lat_min}&lon_min=${lon_min}&lat_max=${lat_max}&lon_max=${lon_max}`,
    { Authorization: key },
    res
  );
});

// ── RSS Proxy ────────────────────────────────────────────────
app.get('/rss', auth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  await proxy(url, { Accept: 'application/rss+xml, application/xml, text/xml, */*' }, res);
});

// ── OREF Israel Alerts ───────────────────────────────────────
app.get('/oref', auth, async (req, res) => {
  await proxy(
    'https://www.oref.org.il/WarningMessages/History/AlertsHistory.json',
    { Referer: 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest' },
    res
  );
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ARKA Relay Server running on port ${PORT}`);
  console.log(`Auth: ${RELAY_SECRET ? 'enabled' : 'DISABLED (set RELAY_SHARED_SECRET)'}`);
});
