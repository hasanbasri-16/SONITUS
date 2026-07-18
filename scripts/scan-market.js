// scripts/scan-market.js
//
// Runs inside a GitHub Actions scheduled workflow (every ~15 minutes).
//
// Data sources, kept deliberately separate so nothing gets mixed:
//   - CoinGecko -> price, market cap, 1h/24h PRICE change
//   - Bybit     -> ALL volume metrics (Vol/MCap ratio AND 24h volume change),
//                  sourced entirely from USDT perpetual futures ("linear"
//                  category). Coins with no Bybit futures market simply don't
//                  get a volume metric and are excluded from the volume-based
//                  panels — better than silently mixing in spot volume.
//
// NOTE: we originally used Binance for this, but Binance's API returns
// HTTP 451 for GitHub Actions' datacenter IPs (a documented Binance
// restriction on cloud-provider IP ranges, not something we did wrong).
// Bybit does not apply the same block, so we switched to Bybit's V5 API.
//
// Usage: node scripts/scan-market.js <output-file-path>

const fs = require('fs');
const path = require('path');

const TRACK_COUNT = 250; // CoinGecko per_page max in a single call — cheap, one request
const KLINES_SPACING_MS = 150; // pacing between Bybit klines calls (polite, well under Bybit's generous limits)
const REQUEST_TIMEOUT_MS = 8000;

const MARKETS_URL = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${TRACK_COUNT}&page=1&price_change_percentage=1h,24h`;
const CATEGORIES_URL = 'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc';
const BYBIT_TICKERS_URL = 'https://api.bybit.com/v5/market/tickers?category=linear';
const BYBIT_KLINES_URL = (symbol) =>
  `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=50`;

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node scan-market.js <output-file-path>');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      // Some exchanges' WAFs (Cloudflare etc.) block requests that look like
      // default server/bot traffic. A normal browser User-Agent avoids that.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  }).finally(() => clearTimeout(timer));
}

// Bybit kline row: [startTime, open, high, low, close, volume, turnover]
// turnover (index 6) is the quote-asset (USDT) notional volume for that hour.
// We compare the SUM of the most recent 24 hourly candles against the SUM of
// the 24 hours before that — a proper rolling 24h volume comparison. Comparing
// two single hours (what we did before) is noisy: if the "24h ago" hour
// happened to have near-zero volume, the resulting % swings to absurd values.
async function fetchFuturesVolumeChange(symbol) {
  const res = await fetchWithTimeout(BYBIT_KLINES_URL(symbol), REQUEST_TIMEOUT_MS);
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  const data = await res.json();
  if (data.retCode !== 0 || !data.result || !Array.isArray(data.result.list)) return null;
  const rows = [...data.result.list].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (rows.length < 48) return null; // need two full 24h windows
  const turnovers = rows.map(r => parseFloat(r[6])).filter(v => !isNaN(v));
  const last48 = turnovers.slice(-48);
  const previous24 = last48.slice(0, 24);
  const recent24 = last48.slice(24, 48);
  const prevSum = previous24.reduce((a, b) => a + b, 0);
  const recentSum = recent24.reduce((a, b) => a + b, 0);
  if (!prevSum || prevSum <= 0) return null;
  return ((recentSum - prevSum) / prevSum) * 100;
}

function loadExisting(outputPath) {
  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function main() {
  const existing = loadExisting(outputPath);
  const volumeMap = (existing && existing.volumeHistory) || {};

  console.log('Fetching CoinGecko market snapshot (price/mcap only)...');
  const marketsRes = await fetchWithTimeout(MARKETS_URL, 10000);
  if (!marketsRes.ok) throw new Error('markets fetch failed: HTTP ' + marketsRes.status);
  const coins = await marketsRes.json();
  console.log(`Got ${coins.length} coins.`);

  console.log('Fetching categories...');
  let categories = (existing && existing.categories) || [];
  try {
    const catRes = await fetchWithTimeout(CATEGORIES_URL, 8000);
    if (catRes.ok) {
      const cats = await catRes.json();
      categories = cats.filter(c => c.market_cap).slice(0, 20);
    }
  } catch (e) {
    console.warn('Categories fetch failed, keeping previous data:', e.message);
  }

  console.log('Fetching Bybit Futures 24h tickers (bulk)...');
  const futuresSymbols = {}; // base symbol (lowercase) -> Bybit symbol, e.g. "ondo" -> "ONDOUSDT"
  try {
    const futRes = await fetchWithTimeout(BYBIT_TICKERS_URL, 10000);
    if (futRes.ok) {
      const data = await futRes.json();
      if (data.retCode === 0 && data.result && Array.isArray(data.result.list)) {
        for (const t of data.result.list) {
          if (t.symbol && t.symbol.endsWith('USDT')) {
            const base = t.symbol.slice(0, -4).toLowerCase();
            futuresSymbols[base] = t.symbol;
            const c = coins.find(c => c.symbol.toLowerCase() === base);
            if (c) c.futures_volume_24h = parseFloat(t.turnover24h);
          }
        }
      } else {
        console.warn('Bybit tickers response not OK:', data.retMsg);
      }
    } else {
      console.warn('Bybit tickers fetch failed: HTTP', futRes.status);
    }
  } catch (e) {
    console.warn('Bybit tickers fetch failed:', e.message);
  }

  const matchedCoins = coins.filter(c => c.futures_volume_24h);
  console.log(`${matchedCoins.length}/${coins.length} coins have a Bybit Futures market.`);

  console.log('Scanning Bybit Futures volume history for matched coins...');
  let ok = 0, failed = 0;
  for (const c of matchedCoins) {
    const symbol = futuresSymbols[c.symbol.toLowerCase()];
    try {
      const pct = await fetchFuturesVolumeChange(symbol);
      volumeMap[c.id] = { pct, updatedAt: new Date().toISOString() };
      ok++;
    } catch (e) {
      failed++;
      if (e.message === 'RATE_LIMIT') {
        console.warn(`Rate limited on ${symbol}, backing off 5s...`);
        await sleep(5000);
      } else {
        console.warn(`Failed on ${symbol}: ${e.message}`);
      }
      // keep previous value for this coin if any
    }
    await sleep(KLINES_SPACING_MS);
  }
  console.log(`Volume scan done: ${ok} ok, ${failed} failed.`);

  // Coins with no futures market get no volume entry at all — the frontend
  // treats "missing from volumeHistory" as "excluded from volume panels",
  // which is exactly what we want instead of a misleading spot fallback.

  const payload = {
    ok: true,
    coins,
    marketUpdatedAt: new Date().toISOString(),
    volumeHistory: volumeMap,
    volumeUpdatedAt: new Date().toISOString(),
    categories,
    categoriesUpdatedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload));
  console.log('Wrote', outputPath);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
