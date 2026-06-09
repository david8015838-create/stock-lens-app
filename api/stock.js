// Zero dependencies — pure Node.js https, no crumb needed for chart API
const https = require('https');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

const VERSIONS = ['v8', 'v7', 'v6'];
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function resolveSymbol(ticker) {
  const t = ticker.trim().toUpperCase();
  if (t.includes('.') || t.startsWith('^') || t.endsWith('-USD') || t.endsWith('-USDT')) return t;
  if (/^\d{4}$/.test(t)) return `${t}.TW`;   // Taiwan listed stock
  if (/^\d{5}$/.test(t)) return `${t}.TWO`;  // Taiwan OTC
  return t;
}

function fetchJson(url, headers, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('rate_limited'));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`parse_error: ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchQuote(symbol) {
  const ver = rand(VERSIONS);
  const host = rand(HOSTS);
  const cb = Date.now();
  const url = `https://${host}/${ver}/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=1d&_=${cb}`;

  const headers = {
    'User-Agent': rand(USER_AGENTS),
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };

  const json = await fetchJson(url, headers);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'no_data');

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

  const results = await Promise.all(
    tickerList.map(async (rawTicker) => {
      const symbol = resolveSymbol(rawTicker);
      try {
        const data = await fetchQuote(symbol);
        return { rawTicker, symbol, ...data, error: null };
      } catch (err) {
        // Retry once with the other host on rate_limited or parse errors
        if (err.message === 'rate_limited' || err.message.startsWith('parse_error')) {
          try {
            const data = await fetchQuote(symbol);
            return { rawTicker, symbol, ...data, error: null };
          } catch {}
        }
        return {
          rawTicker, symbol,
          price: null, change: null, changePercent: null,
          name: rawTicker, currency: 'USD',
          error: err.message,
        };
      }
    })
  );

  // Always 200 — errors are per-symbol, never crash the frontend
  return res.status(200).json({ results, ts: Date.now() });
};
