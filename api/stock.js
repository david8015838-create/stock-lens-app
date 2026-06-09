// Multi-source: TWSE (台股) + CoinGecko (crypto) + Yahoo Finance (US stocks/indexes)
// Zero external dependencies — pure Node.js built-in https
const https = require('https');

// ── Helpers ─────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function httpsGet(url, headers = {}, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ body, cookies, status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJson(url, headers) {
  const { body, status } = await httpsGet(url, headers);
  if (status === 429) throw new Error('rate_limited');
  if (status >= 400 && status !== 404) throw new Error(`http_${status}`);
  try { return JSON.parse(body); }
  catch (e) { throw new Error(`parse_error: ${body.slice(0, 60)}`); }
}

// ── Symbol routing ───────────────────────────────────────────────────────────

const CRYPTO_IDS = {
  'BTC-USD': 'bitcoin',
  'ETH-USD': 'ethereum',
  'SOL-USD': 'solana',
  'BNB-USD': 'binancecoin',
  'XRP-USD': 'ripple',
  'ADA-USD': 'cardano',
  'DOGE-USD': 'dogecoin',
  'AVAX-USD': 'avalanche-2',
  'MATIC-USD': 'matic-network',
};

function classify(rawTicker) {
  const t = rawTicker.toUpperCase();
  if (/^\d{4}$/.test(t)) return 'twse-listed';
  if (/^\d{5}$/.test(t)) return 'twse-otc';
  if (CRYPTO_IDS[t] || (t.endsWith('-USD') && !t.startsWith('^'))) return 'crypto';
  return 'yahoo';
}

// ── TWSE (Taiwan Stock Exchange) ─────────────────────────────────────────────

async function fetchTWSE(code, exchange) {
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exchange}_${code}.tw&json=1&delay=0`;
  const json = await fetchJson(url, {
    'User-Agent': rand(USER_AGENTS),
    'Referer': 'https://mis.twse.com.tw/',
    'Accept': 'application/json',
  });

  const info = json?.msgArray?.[0];
  if (!info) throw new Error('no_data');

  const rawPrice = info.z !== '-' ? info.z : info.y;
  const price = parseFloat(rawPrice);
  const prevClose = parseFloat(info.y);
  if (isNaN(price)) throw new Error('invalid_price');

  const change = price - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

  return {
    price,
    change,
    changePercent: changePct,
    name: info.n || code,
    currency: 'TWD',
    marketState: info.z !== '-' ? 'REGULAR' : 'CLOSED',
  };
}

// ── CoinGecko (Crypto) ───────────────────────────────────────────────────────

async function fetchCrypto(ticker) {
  const coinId = CRYPTO_IDS[ticker.toUpperCase()]
    || ticker.toUpperCase().replace('-USD', '').toLowerCase();

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
  const json = await fetchJson(url, {
    'User-Agent': rand(USER_AGENTS),
    'Accept': 'application/json',
  });

  const data = json[coinId];
  if (!data) throw new Error('no_data');

  const price = data.usd;
  const changePct = data.usd_24h_change ?? 0;
  const change = price * (changePct / 100);

  return {
    price,
    change,
    changePercent: changePct,
    name: coinId.charAt(0).toUpperCase() + coinId.slice(1),
    currency: 'USD',
    marketState: 'REGULAR',
  };
}

// ── Yahoo Finance (US stocks & indexes) ──────────────────────────────────────

// Module-level session cache — survives warm invocations
let _yfSession = null;
let _yfSessionTs = 0;
const YF_SESSION_TTL = 20 * 60 * 1000; // 20 min

async function getYFSession() {
  if (_yfSession && Date.now() - _yfSessionTs < YF_SESSION_TTL) return _yfSession;

  const ua = rand(USER_AGENTS);
  // Get cookie from Yahoo Finance main page
  const { cookies } = await httpsGet('https://finance.yahoo.com/', {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }, 8000);

  _yfSession = { cookie: cookies, ua };
  _yfSessionTs = Date.now();
  return _yfSession;
}

async function fetchYahoo(symbol) {
  let session;
  try { session = await getYFSession(); }
  catch { session = { cookie: '', ua: rand(USER_AGENTS) }; }

  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const versions = ['v8', 'v7', 'v6'];
  const cb = Date.now();
  const url = `https://${rand(hosts)}/${rand(versions)}/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=1d&_=${cb}`;

  const headers = {
    'User-Agent': session.ua,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    ...(session.cookie ? { 'Cookie': session.cookie } : {}),
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

// ── Main handler ─────────────────────────────────────────────────────────────

async function resolveQuote(rawTicker) {
  const type = classify(rawTicker);
  const upper = rawTicker.toUpperCase();

  switch (type) {
    case 'twse-listed':
      return fetchTWSE(upper, 'tse');
    case 'twse-otc':
      return fetchTWSE(upper, 'otc');
    case 'crypto':
      return fetchCrypto(upper);
    default:
      return fetchYahoo(upper);
  }
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
      try {
        const data = await resolveQuote(rawTicker);
        return { rawTicker, ...data, error: null };
      } catch (err) {
        // One retry on transient errors
        if (['rate_limited', 'timeout', 'no_data'].includes(err.message)) {
          try {
            const data = await resolveQuote(rawTicker);
            return { rawTicker, ...data, error: null };
          } catch {}
        }
        return {
          rawTicker,
          price: null, change: null, changePercent: null,
          name: rawTicker, currency: 'USD',
          error: err.message,
        };
      }
    })
  );

  // Always 200 — errors embedded per symbol, never crash the frontend
  return res.status(200).json({ results, ts: Date.now() });
};
