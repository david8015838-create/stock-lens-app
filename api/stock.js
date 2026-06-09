const yahooFinance = require('yahoo-finance2').default;

yahooFinance.suppressNotices(['yahooSurvey']);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function resolveSymbol(ticker) {
  const t = ticker.trim().toUpperCase();
  // Already has exchange suffix or is an index/crypto
  if (t.includes('.') || t.startsWith('^') || t.endsWith('-USD') || t.endsWith('-USDT')) return t;
  // Taiwan listed: pure 4-digit number
  if (/^\d{4}$/.test(t)) return `${t}.TW`;
  // Taiwan OTC: pure 5-digit number
  if (/^\d{5}$/.test(t)) return `${t}.TWO`;
  return t;
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbols } = req.query;
  if (!symbols) {
    return res.status(200).json({ results: [] });
  }

  const tickerList = symbols
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 30);

  const queryOptions = {
    fetchOptions: {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        // cache buster via custom header (Yahoo ignores it but varies the request)
        'X-CB': Date.now().toString(),
      },
    },
  };

  const results = await Promise.all(
    tickerList.map(async (rawTicker) => {
      const symbol = resolveSymbol(rawTicker);
      try {
        const quote = await yahooFinance.quote(symbol, {}, { ...queryOptions, validateResult: false });
        return {
          rawTicker,
          symbol,
          price: quote.regularMarketPrice ?? null,
          change: quote.regularMarketChange ?? null,
          changePercent: quote.regularMarketChangePercent ?? null,
          name: quote.longName || quote.shortName || rawTicker,
          currency: quote.currency || 'USD',
          marketState: quote.marketState || 'REGULAR',
          error: null,
        };
      } catch (err) {
        return {
          rawTicker,
          symbol,
          price: null,
          change: null,
          changePercent: null,
          name: rawTicker,
          currency: 'USD',
          marketState: null,
          error: String(err.message || err),
        };
      }
    })
  );

  // Always 200 — frontend never crashes
  return res.status(200).json({ results, ts: Date.now() });
};
