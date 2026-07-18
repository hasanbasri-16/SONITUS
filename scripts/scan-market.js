// scripts/scan-market.js
//
// Runs inside a GitHub Actions scheduled workflow (every ~15 minutes).
//
// Data sources, kept deliberately separate so nothing gets mixed:
//   - CoinGecko  -> price, market cap, 1h/24h PRICE change (spot-market based,
//                   but we don't use CoinGecko for any volume metric anymore)
//   - Binance    -> ALL volume metrics (Vol/MCap ratio AND 24h volume change),
//                   sourced entirely from USDT-M perpetual futures. Coins with
//                   no Binance futures market simply don't get a volume metric
//                   and are excluded from the volume-based panels — better than
//                   silently falling back to spot volume and mixing two
//                   incomparable numbers in the same ranking.
//
// Binance's rate limits are far more generous than CoinGecko's free tier, so
// this run finishes much faster than the old CoinGecko-per-coin version did.
//
// Usage: node scripts/scan-market.js <output-file-path>

const fs = require('fs');
const path = require('path');

const TRACK_COUNT = 250; // CoinGecko per_page max in a single call — cheap, one request
const KLINES_SPACING_MS = 150; // pacing between Binance klines calls (Binance is generous, this is just politeness)
const REQUEST_TIMEOUT_MS = 8000;

const MARKETS_URL = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${TRACK_COUNT}&page=1&price_change_percentage=1h,24h`;
const CATEGORIES_URL = 'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc';
const BINANCE_FUTURES_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const BINANCE_FUTURES_KLINES_URL = (symbol) =>
  `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=25`;

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node scan-market.js <output-file-path>');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Klines format: [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
// quoteVolume (index 7) is the USD-ish notional volume for that hour — summing/comparing
// these gives us a real "now vs ~24h ago" volume change, same idea as before but Binance-sourced.
async function fetchFuturesVolumeChange(symbol) {
  const res = await fetchWithTimeout(BINANCE_FUTURES_KLINES_URL(symbol), REQUEST_TIMEOUT_MS);
  if (res.status === 429 || res.status === 418) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  const klines = await res.json();
  if (!Array.isArray(klines) || klines.length < 2) return null;
  // Compare the most recent hour's volume to the hour ~24h ago (first entry in a 25h window)
  const nowVol = parseFloat(klines[klines.length - 1][7]);
  const pastVol = parseFloat(klines[0][7]);
  if (!pastVol || isNaN(pastVol) || isNaN(nowVol)) return null;
  return ((nowVol - pastVol) / pastVol) * 100;
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

  console.log('Fetching Binance Futures 24h ticker (bulk)...');
  const futuresSymbols = {}; // base symbol (lowercase) -> Binance futures symbol, e.g. "ondo" -> "ONDOUSDT"
  try {
    const futRes = await fetchWithTimeout(BINANCE_FUTURES_TICKER_URL, 10000);
    if (futRes.ok) {
      const tickers = await futRes.json();
      for (const t of tickers) {
        if (t.symbol && t.symbol.endsWith('USDT')) {
          const base = t.symbol.slice(0, -4).toLowerCase();
          futuresSymbols[base] = t.symbol;
          const c = coins.find(c => c.symbol.toLowerCase() === base);
          if (c) c.futures_volume_24h = parseFloat(t.quoteVolume);
        }
      }
    } else {
      console.warn('Binance Futures ticker fetch failed: HTTP', futRes.status);
    }
  } catch (e) {
    console.warn('Binance Futures ticker fetch failed:', e.message);
  }

  const matchedCoins = coins.filter(c => c.futures_volume_24h);
  console.log(`${matchedCoins.length}/${coins.length} coins have a Binance Futures market.`);

  console.log('Scanning Binance Futures volume history for matched coins...');
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
