// Pure Node.js built-in https — zero external dependencies
const https = require('https');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Module-level crumb cache — survives across warm invocations
let _crumb = null;
let _cookie = null;
let _cacheTs = 0;
const CRUMB_TTL = 25 * 60 * 1000; // 25 min

function resolveSymbol(ticker) {
  const t = ticker.trim().toUpperCase();
  if (t.includes('.') || t.startsWith('^') || t.endsWith('-USD') || t.endsWith('-USDT')) return t;
  if (/^\d{4}$/.test(t)) return `${t}.TW`;   // Taiwan listed
  if (/^\d{5}$/.test(t)) return `${t}.TWO`;  // Taiwan OTC
  return t;
}

function httpsGet(url, headers, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ body, cookies, status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function ensureCrumb() {
  if (_crumb && Date.now() - _cacheTs < CRUMB_TTL) return;

  const ua = randomUA();

  // Step 1 — get Yahoo cookie (fc.yahoo.com is faster than finance.yahoo.com)
  const { cookies } = await httpsGet(
    'https://fc.yahoo.com/',
    { 'User-Agent': ua, 'Accept': 'text/html' }
  );
  const cookie = cookies.map(c => c.split(';')[0]).join('; ');

  // Step 2 — get crumb
  const { body: crumb } = await httpsGet(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    { 'User-Agent': ua, 'Cookie': cookie }
  );

  _crumb = crumb.trim();
  _cookie = cookie;
  _cacheTs = Date.now();
}

async function fetchQuote(symbol) {
  const cacheBust = Date.now();
  // Randomly rotate between v6/v7/v8 chart endpoint
  const ver = ['v6', 'v7', 'v8'][Math.floor(Math.random() * 3)];
  const url = `https://query1.finance.yahoo.com/${ver}/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=1d&crumb=${encodeURIComponent(_crumb)}&_=${cacheBust}`;

  const { body, status } = await httpsGet(url, {
    'User-Agent': randomUA(),
    'Cookie': _cookie,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  });

  if (status === 401 || status === 403) {
    // Force crumb refresh on next call
    _crumb = null;
    throw new Error(`Auth error ${status}`);
  }

  const json = JSON.parse(body);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'No data');

  const meta = result.meta;
  const price = meta.regularMarketPrice ?? null;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;

  return {
    price,
    change,
    changePercent: changePct,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || 'USD',
    marketState: meta.marketState || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols } = req.query;
  if (!symbols) return res.status(200).json({ results: [] });

  const tickerList = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);

  // Always return 200 — errors are embedded per-symbol
  try {
    await ensureCrumb();
  } catch (e) {
    return res.status(200).json({
      results: tickerList.map(t => ({
        rawTicker: t, symbol: resolveSymbol(t),
        price: null, change: null, changePercent: null,
        name: t, currency: 'USD', error: `Crumb fetch failed: ${e.message}`,
      })),
      ts: Date.now(),
    });
  }

  const results = await Promise.all(
    tickerList.map(async (rawTicker) => {
      const symbol = resolveSymbol(rawTicker);
      try {
        const data = await fetchQuote(symbol);
        return { rawTicker, symbol, ...data, error: null };
      } catch (err) {
        return {
          rawTicker, symbol,
          price: null, change: null, changePercent: null,
          name: rawTicker, currency: 'USD',
          error: String(err.message || err),
        };
      }
    })
  );

  return res.status(200).json({ results, ts: Date.now() });
};
