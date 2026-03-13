// ============================================================
//  ARKA Intelligence Center — Relay Server v9
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
    /^https:\/\/.*\.arkaltd\.io$/,
    /^https:\/\/world\.arkaltd\.io$/,
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
async function fetchJSON(url, opts = {}, timeout = 15000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent':'ARKARelay/7.0', Accept:'application/json', ...(opts.headers||{}) },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 429) {
        if (attempt < retries) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
        throw new Error('HTTP 429');
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch(e) {
      clearTimeout(t);
      if (attempt < retries && !e.message.includes('429')) { await new Promise(r => setTimeout(r, 1000)); continue; }
      throw e;
    }
  }
}

// ── /health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status:'ok', version:9, ts: new Date().toISOString(),
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
    // Stocks & ETFs (Finnhub /quote)
    const stockSyms = [
      'AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA','META','TSM',
      'SPY','QQQ','GLD','TLT','XLF','USO','UNG','SLV','DBB',
    ];
    // Crypto via Binance on Finnhub
    const cryptoSyms = [
      'BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:SOLUSDT',
      'BINANCE:BNBUSDT','BINANCE:XRPUSDT','BINANCE:USDCUSDT',
    ];
    const syms = [...stockSyms, ...cryptoSyms];
    const [stockResults, fxData] = await Promise.all([
      Promise.allSettled(
        syms.map(s => fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`).then(d=>({s,d})))
      ),
      Promise.all([
        fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,JPY,MXN,CAD,CHF,BRL,AUD,CNY'),
        fetchJSON('https://api.frankfurter.app/latest?from=USD&to=MXN,BRL,JPY,EUR,GBP,CAD,CHF,ARS,CLP'),
      ]).catch(() => [null, null]),
    ]);
    const data = {};
    for (const r of stockResults) {
      if (r.status==='fulfilled') data[r.value.s] = r.value.d;
    }
    // Inyectar pares FX desde Frankfurter en formato compatible con fromQuote
    const [eurRates, usdRates] = fxData;
    const fxPairs = {
      'FX:EUR_USD': { base: 'EUR', quote: 'USD', rate: eurRates?.rates?.USD },
      'FX:EUR_MXN': { base: 'EUR', quote: 'MXN', rate: eurRates?.rates?.MXN },
      'FX:EUR_GBP': { base: 'EUR', quote: 'GBP', rate: eurRates?.rates?.GBP },
      'FX:EUR_JPY': { base: 'EUR', quote: 'JPY', rate: eurRates?.rates?.JPY },
      'FX:EUR_BRL': { base: 'EUR', quote: 'BRL', rate: eurRates?.rates?.BRL },
      'FX:USD_MXN': { base: 'USD', quote: 'MXN', rate: usdRates?.rates?.MXN },
      'FX:USD_BRL': { base: 'USD', quote: 'BRL', rate: usdRates?.rates?.BRL },
      'FX:USD_JPY': { base: 'USD', quote: 'JPY', rate: usdRates?.rates?.JPY },
      'FX:USD_CAD': { base: 'USD', quote: 'CAD', rate: usdRates?.rates?.CAD },
      'FX:USD_CHF': { base: 'USD', quote: 'CHF', rate: usdRates?.rates?.CHF },
      'FX:GBP_USD': { base: 'GBP', quote: 'USD', rate: eurRates?.rates?.USD && eurRates?.rates?.GBP ? (eurRates.rates.USD / eurRates.rates.GBP) : null },
    };
    for (const [sym, fx] of Object.entries(fxPairs)) {
      if (fx.rate) data[sym] = { c: fx.rate, dp: 0, h: fx.rate, l: fx.rate, o: fx.rate };
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
    setCached(ck, data, 1_800_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});



// ── /fx ───────────────────────────────────────────────────────
app.get('/fx', auth, async (req, res) => {
  const ck = 'fx_rates';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const [eurBase, usdBase] = await Promise.all([
      fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,JPY,MXN,CAD,CHF,BRL,AUD,CNY'),
      fetchJSON('https://api.frankfurter.app/latest?from=USD&to=MXN,BRL,JPY,EUR,GBP,CAD,CHF,ARS,CLP'),
    ]);
    const data = { eur: eurBase, usd: usdBase, ts: Date.now() };
    setCached(ck, data, 300_000); // caché 5 min
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

// ── /firms ───────────────────────────────────────────────────
app.get('/firms', auth, async (req, res) => {
  const NASA_KEY = process.env.NASA_FIRMS_KEY || '98e3b5113209d4813a6e82eda1dc0bea';
  const ck = 'firms_fires';
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_KEY}/VIIRS_SNPP_NRT/world/1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await resp.text();
    setCache(ck, { csv: text }, 10 * 60 * 1000); // caché 10 min
    res.json({ csv: text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
// OpenSky free: ~6000 states con OAuth2, ~400 sin auth
// Estrategia: intentar OAuth2 primero, fallback a anon, cache 2min
let _osToken = null;
let _osTokenExp = 0;

async function getOSToken() {
  if (_osToken && Date.now() < _osTokenExp - 30000) return _osToken;
  const id = process.env.OPENSKY_CLIENT_ID;
  const sec = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !sec) return null;
  try {
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({ grant_type:'client_credentials', client_id:id, client_secret:sec }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const { access_token, expires_in } = await r.json();
    _osToken = access_token;
    _osTokenExp = Date.now() + (expires_in * 1000);
    return access_token;
  } catch { return null; }
}

app.get('/opensky', auth, async (req, res) => {
  const ck = 'opensky_global';
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  const { lamin='-60', lamax='75', lomin='-180', lomax='180' } = req.query;
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

  // Intento 1: con OAuth2 (más estados, menos rate-limit)
  const token = await getOSToken();
  if (token) {
    try {
      const data = await fetchJSON(url, { headers:{ Authorization:`Bearer ${token}` } }, 25000, 1);
      if (data?.states?.length) {
        setCached(ck, data, 120_000);
        return res.json(data);
      }
    } catch(e) {
      if (e.message.includes('401') || e.message.includes('403')) { _osToken = null; } // invalidar token
    }
  }

  // Intento 2: anónimo (sin auth — devuelve ~400 estados pero siempre funciona)
  try {
    const data = await fetchJSON(url, {}, 20000, 1);
    setCached(ck, data, 120_000);
    return res.json(data);
  } catch(e) {
    return res.status(503).json({ error:`OpenSky unavailable: ${e.message}`, states:[] });
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
    const r = await fetch(url, { headers:{'User-Agent':'ARKARelay/7.0','Accept':'application/rss+xml,application/xml,text/xml,*/*'} });
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
    const params = new URLSearchParams({
      query:'ransomware cyberattack "zero-day" APT malware "data breach" hacking intrusion',
      mode:'artlist', maxrecords:'15', timespan:'24h', sort:'hybridrel', format:'json',
    });
    const data = await fetchJSON(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
    const items = (data.articles||[]).map(a=>({ title:a.title, src:a.domain, url:a.url, time:a.seendate }));
    setCached(ck, items, 1_800_000);
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
    setCached(ck, items, 1_800_000);
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
      body: JSON.stringify({ model:'llama-3.3-70b-versatile', messages, max_tokens, temperature:0.3 }),
    });
    if (r.status===429) return res.status(429).json({error:'Groq rate limited'});
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const data = await r.json();
    setCached(ck, data, 600_000);
    res.json(data);
  } catch(e){ res.status(502).json({error:e.message}); }
});

app.listen(PORT, () => {
  console.log(`ARKA Relay v9 on :${PORT} | Auth:${SECRET?'ON':'OFF'}`);
});
// updated viernes, 13 de marzo de 2026, 16:31:54 CST
