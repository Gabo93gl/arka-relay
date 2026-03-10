// ============================================================
//  ARKA Intelligence Center — Relay Server v5
//  Rewrite limpio — Mar 2026
// ============================================================
import express from 'express';
import fetch   from 'node-fetch';
import cors    from 'cors';

const app    = express();
const SECRET = process.env.RELAY_SHARED_SECRET || '';
const PORT   = process.env.PORT || 3001;

// ── Middlewares ───────────────────────────────────────────────
app.use(cors({
  origin: [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https:\/\/.*\.vercel\.app$/,
    /^https:\/\/.*\.up\.railway\.app$/,
    /^https:\/\/arka-intelligence\.vercel\.app$/,
  ],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-relay-key','Authorization'],
}));
app.options('*', cors());
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  if (!SECRET) return next();
  const k = req.headers['x-relay-key'] || (req.headers.authorization||'').replace('Bearer ','');
  if (k !== SECRET) return res.status(401).json({ error:'Unauthorized' });
  next();
}

// ── In-memory cache ───────────────────────────────────────────
const cache = new Map();
function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(k); return null; }
  return e.data;
}
function setCached(k, data, ttlMs = 300_000) {
  cache.set(k, { data, exp: Date.now() + ttlMs });
}

// ── fetchJSON helper ──────────────────────────────────────────
async function fetchJSON(url, opts = {}, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent':'ARKARelay/5.0', Accept:'application/json', ...(opts.headers||{}) },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ── /health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status:'ok', version:5, ts: new Date().toISOString(),
    endpoints:['/health','/market-snapshot','/finnhub','/fred','/nyt',
               '/newsapi','/gdelt','/polymarket','/opensky','/ais',
               '/rss','/oref','/ai','/cyber-feed','/military-feed'] });
});

// ── /market-snapshot ─────────────────────────────────────────
app.get('/market-snapshot', auth, async (req, res) => {
  const ck = 'market_snap';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    await new Promise(r => setTimeout(r, 1500));
    const key = process.env.FINNHUB_API_KEY;
    const syms = ['AAPL','MSFT','GOOGL','AMZN','TSLA','SPY','QQQ','GLD','TLT','BTC-USD'];
    const results = await Promise.allSettled(
      syms.map(s => fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`).then(d=>({s,d})))
    );
    const data = {};
    for (const r of results) {
      if (r.status==='fulfilled') data[r.value.s] = r.value.d;
    }
    setCached(ck, data, 180_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /finnhub ─────────────────────────────────────────────────
app.get('/finnhub', auth, async (req, res) => {
  const key = process.env.FINNHUB_API_KEY;
  const { path: p='quote', ...rest } = req.query;
  const params = new URLSearchParams({...rest, token:key});
  try {
    const data = await fetchJSON(`https://finnhub.io/api/v1/${p}?${params}`);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /fred ─────────────────────────────────────────────────────
app.get('/fred', auth, async (req, res) => {
  const key = process.env.FRED_API_KEY;
  const ck = `fred_${JSON.stringify(req.query)}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const params = new URLSearchParams({...req.query, api_key:key, file_type:'json'});
    const data = await fetchJSON(`https://api.stlouisfed.org/fred/series/observations?${params}`);
    setCached(ck, data, 3600_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /nyt ─────────────────────────────────────────────────────
app.get('/nyt', auth, async (req, res) => {
  const key = process.env.NYT_API_KEY;
  const ck = `nyt_${JSON.stringify(req.query)}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const params = new URLSearchParams({...req.query, 'api-key':key});
    const data = await fetchJSON(`https://api.nytimes.com/svc/search/v2/articlesearch.json?${params}`);
    setCached(ck, data, 900_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /newsapi ─────────────────────────────────────────────────
app.get('/newsapi', auth, async (req, res) => {
  const key = process.env.NEWSAPI_KEY;
  const ck = `newsapi_${JSON.stringify(req.query)}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const params = new URLSearchParams(req.query);
    const data = await fetchJSON(`https://newsapi.org/v2/everything?${params}`,
      { headers:{'X-Api-Key':key} });
    setCached(ck, data, 600_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /gdelt ───────────────────────────────────────────────────
app.get('/gdelt', auth, async (req, res) => {
  const ck = `gdelt_${JSON.stringify(req.query)}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const params = new URLSearchParams({...req.query, format:'json'});
    const data = await fetchJSON(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
    setCached(ck, data, 900_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /polymarket ───────────────────────────────────────────────
app.get('/polymarket', auth, async (req, res) => {
  const ck = `poly_${JSON.stringify(req.query)}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const params = new URLSearchParams(req.query);
    const data = await fetchJSON(`https://gamma-api.polymarket.com/markets?${params}`);
    setCached(ck, data, 600_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /opensky ─────────────────────────────────────────────────
app.get('/opensky', auth, async (req, res) => {
  const ck = 'opensky_global';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  const { lamin='-60', lamax='75', lomin='-180', lomax='180' } = req.query;
  try {
    const id  = process.env.OPENSKY_CLIENT_ID;
    const sec = process.env.OPENSKY_CLIENT_SECRET;
    // OAuth2 token
    const tokenRes = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({ grant_type:'client_credentials', client_id:id, client_secret:sec }),
    });
    if (!tokenRes.ok) throw new Error(`OpenSky token ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();
    const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;
    const data = await fetchJSON(url, { headers:{ Authorization:`Bearer ${access_token}` } });
    setCached(ck, data, 120_000);
    res.json(data);
  } catch(e){
    // Fallback sin auth (rate-limited pero funcional)
    try {
      const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;
      const data = await fetchJSON(url);
      setCached(ck, data, 120_000);
      res.json(data);
    } catch(e2){ res.status(503).json({error:`OpenSky: ${e2.message}`}); }
  }
});

// ── /ais ─────────────────────────────────────────────────────
app.get('/ais', auth, async (req, res) => {
  const ck = 'ais_global';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const apiKey = process.env.AISSTREAM_API_KEY;
    // AISStream REST snapshot — últimos 200 vessels activos
    const data = await fetchJSON(
      `https://api.aisstream.io/v0/vessel/location?apiKey=${apiKey}&limit=200`
    );
    setCached(ck, data, 120_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /rss ─────────────────────────────────────────────────────
app.get('/rss', auth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({error:'url required'});
  const ck = `rss_${url}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(url, { headers:{'User-Agent':'ARKARelay/5.0','Accept':'application/rss+xml,application/xml,text/xml,*/*'} });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    setCached(ck, { xml: text }, 900_000);
    res.json({ xml: text });
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /oref ─────────────────────────────────────────────────────
app.get('/oref', auth, async (req, res) => {
  try {
    const data = await fetchJSON('https://www.oref.org.il/WarningMessages/History/AlertsHistory.json',
      { headers:{ Referer:'https://www.oref.org.il/' } });
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /cyber-feed ───────────────────────────────────────────────
app.get('/cyber-feed', auth, async (req, res) => {
  const ck = 'cyber_feed';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const key = process.env.NEWSAPI_KEY;
    const params = new URLSearchParams({
      q: 'ransomware OR cyberattack OR "zero-day" OR "data breach" OR APT OR malware',
      language:'en', sortBy:'publishedAt', pageSize:'12',
    });
    const data = await fetchJSON(`https://newsapi.org/v2/everything?${params}`,
      { headers:{'X-Api-Key':key} });
    const items = (data.articles||[]).map(a=>({ title:a.title, src:a.source?.name, url:a.url, time:a.publishedAt }));
    setCached(ck, items, 900_000);
    res.json(items);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── /military-feed ────────────────────────────────────────────
app.get('/military-feed', auth, async (req, res) => {
  const ck = 'military_feed';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const params = new URLSearchParams({
      query:'military naval carrier missile troops fighter',
      mode:'artlist', maxrecords:'15', timespan:'24h', sort:'hybridrel', format:'json',
    });
    const data = await fetchJSON(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
    const items = (data.articles||[]).map(a=>({ title:a.title, src:a.domain, url:a.url, time:a.seendate }));
    setCached(ck, items, 1200_000);
    res.json(items);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── /ai ───────────────────────────────────────────────────────
app.post('/ai', auth, async (req, res) => {
  const { messages, max_tokens=400 } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error:'messages array required', got: typeof messages });
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(503).json({ error:'GROQ_API_KEY not configured' });

  const ck = 'ai_' + Buffer.from(messages.map(m=>m.content).join('|')).toString('base64').slice(0,32);
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
      body: JSON.stringify({ model:'llama-3.1-8b-instant', messages, max_tokens, temperature:0.3 }),
    });
    if (r.status===429) return res.status(429).json({error:'Groq rate limited'});
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const data = await r.json();
    setCached(ck, data, 600_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

app.listen(PORT, () => {
  console.log(`ARKA Relay v5 on :${PORT} | Auth:${SECRET?'ON':'OFF'}`);
});

