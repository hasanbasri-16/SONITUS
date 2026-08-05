// scripts/scan-market.js
//
// Runs inside a GitHub Actions scheduled workflow (every ~15 minutes).
//
// Data sources:
//   - CoinMarketCap -> price, market cap, volume_24h, volume_change_24h,
//                      1h/24h price change — ALL in a single bulk call.
//                      CMC's /listings/latest endpoint returns volume_change_24h
//                      directly, so unlike our previous CoinGecko/Binance/Bybit
//                      attempts, there's no need to scan coins one-by-one for
//                      historical volume data at all.
//   - CoinGecko     -> categories panel only (unaffected by any of the
//                      exchange-blocking issues we hit, since it's not an
//                      exchange).
//
// Why we moved off Binance/Bybit: both are exchanges that run bot/IP
// protection in front of their APIs, and GitHub Actions' shared datacenter
// IPs get blocked (Binance: consistently, HTTP 451; Bybit: inconsistently,
// HTTP 403 depending on which IP a given run happens to get). CoinMarketCap
// is a data aggregator, not an exchange — serving API clients including
// scripts/servers is its actual business, so this isn't a concern there.
//
// Requires a free CoinMarketCap API key, provided via the CMC_API_KEY
// environment variable (set as a GitHub Actions secret — never hardcode it
// here).
//
// Usage: CMC_API_KEY=xxxx node scripts/scan-market.js <output-file-path>

const fs = require('fs');
const path = require('path');

const TRACK_COUNT = 200; // coins per CMC listings/latest call
const REQUEST_TIMEOUT_MS = 15000;
const OI_COIN_COUNT = 5;              // how many coins get Open Interest tracking
const OI_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // only refresh OI once per hour, regardless of how often this script runs (credit budget)

// Same stablecoin exclusion as the frontend — no point tracking OI for these.
const STABLECOIN_SYMBOLS = new Set([
  'usdt','usdc','usd1','dai','tusd','fdusd','usdd','usdp','gusd','lusd','usde',
  'pyusd','rlusd','usdg','eurs','eurt','susd','frax','crvusd','busd','usdk',
  'alusd','mim','ustc','dola','usdx','xusd','cusd','usdy','usr','usda','usdb'
]);

const CMC_API_KEY = process.env.CMC_API_KEY;
const CMC_LISTINGS_URL =
  `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?start=1&limit=${TRACK_COUNT}&convert=USD&sort=market_cap`;
const CMC_OI_URL = (cryptoId) =>
  `https://pro-api.coinmarketcap.com/v5/cryptocurrency/derivatives/market-pairs/list/latest?crypto_id=${cryptoId}`;
const CATEGORIES_URL = 'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node scan-market.js <output-file-path>');
  process.exit(1);
}
if (!CMC_API_KEY) {
  console.error('Missing CMC_API_KEY environment variable. Add it as a GitHub Actions secret.');
  process.exit(1);
}

function fetchWithTimeout(url, ms, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, {
    signal: controller.signal,
    headers: { 'Accept': 'application/json', ...headers }
  }).finally(() => clearTimeout(timer));
}

function loadExisting(outputPath) {
  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Fetches Open Interest for one coin and sums it across all its market pairs
// (CMC reports OI per exchange/pair, not a single aggregate). Costs 1 CMC
// credit per call — see OI_COIN_COUNT / OI_REFRESH_INTERVAL_MS above for how
// we keep that affordable.
async function fetchOpenInterest(cryptoId) {
  const res = await fetchWithTimeout(CMC_OI_URL(cryptoId), REQUEST_TIMEOUT_MS, {
    'X-CMC_PRO_API_KEY': CMC_API_KEY
  });
  if (!res.ok) throw new Error('HTTP_' + res.status);
  const json = await res.json();
  const pairs = json.data && json.data.market_pairs;
  if (!Array.isArray(pairs)) return null;
  let totalOI = 0;
  let counted = 0;
  for (const pair of pairs) {
    const oi = pair.quotes && pair.quotes[0] && pair.quotes[0].open_interest;
    if (typeof oi === 'number' && !isNaN(oi)) { totalOI += oi; counted++; }
  }
  if (counted === 0) return null;
  return { totalOI, marketPairCount: pairs.length };
}

// Turns (OI direction, price direction) into a plain-language read on
// whether longs/shorts are opening or closing — the classic 4-quadrant
// open-interest-vs-price framework.
function interpretOI(oiChangePct, priceChangePct) {
  if (oiChangePct === null || priceChangePct === null || oiChangePct === undefined || priceChangePct === undefined) return null;
  const oiUp = oiChangePct > 0;
  const priceUp = priceChangePct > 0;
  if (oiUp && priceUp) return 'longs_opening';
  if (oiUp && !priceUp) return 'shorts_opening';
  if (!oiUp && priceUp) return 'shorts_closing';
  return 'longs_closing';
}

// Maps a CMC listing entry to the shape the frontend expects (kept close to
// the old CoinGecko shape so index.html didn't need a full rewrite).
function mapCoin(entry) {
  const q = entry.quote.USD;
  return {
    id: String(entry.id),          // CMC's numeric id, used as our stable key
    cmc_id: entry.id,
    symbol: entry.symbol.toLowerCase(),
    name: entry.name,
    image: `https://s2.coinmarketcap.com/static/img/coins/64x64/${entry.id}.png`,
    market_cap: q.market_cap,
    market_cap_rank: entry.cmc_rank,
    current_price: q.price,
    total_volume: q.volume_24h,
    price_change_percentage_1h_in_currency: q.percent_change_1h,
    price_change_percentage_24h_in_currency: q.percent_change_24h,
    price_change_percentage_24h: q.percent_change_24h,
    volume_change_24h: q.volume_change_24h // CMC gives this directly — no per-coin scan needed
  };
}

async function main() {
  const existing = loadExisting(outputPath);

  console.log('Fetching CoinMarketCap listings (price/mcap/volume, all in one call)...');
  const res = await fetchWithTimeout(CMC_LISTINGS_URL, REQUEST_TIMEOUT_MS, {
    'X-CMC_PRO_API_KEY': CMC_API_KEY
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CMC fetch failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('Unexpected CMC response shape: ' + JSON.stringify(json).slice(0, 300));
  }
  const coins = json.data.map(mapCoin);
  console.log(`Got ${coins.length} coins from CMC.`);
  if (json.status && json.status.credit_count) {
    console.log(`CMC credits used this call: ${json.status.credit_count}`);
  }

  // ---- Open Interest: only for the top OI_COIN_COUNT coins by volume
  // (stablecoins excluded), and only refreshed once per OI_REFRESH_INTERVAL_MS
  // — regardless of how often this whole script runs (every 10 min) or gets
  // manually triggered. If a manual run happens to land after the cooldown
  // has expired, it refreshes; otherwise it just carries the previous values
  // forward, so credits aren't wasted on redundant OI calls.
  let oiMap = (existing && existing.openInterest) || {};
  let oiUpdatedAt = (existing && existing.oiUpdatedAt) || null;
  const forceRefresh = process.env.FORCE_OI_REFRESH === 'true';
  const oiIsStale = forceRefresh || !oiUpdatedAt || (Date.now() - new Date(oiUpdatedAt).getTime()) > OI_REFRESH_INTERVAL_MS;

  if (oiIsStale) {
    if (forceRefresh) console.log('FORCE_OI_REFRESH is set (manual run) — refreshing OI regardless of cooldown.');
    const topByVolume = [...coins]
      .filter(c => !STABLECOIN_SYMBOLS.has(c.symbol))
      .filter(c => c.total_volume)
      .sort((a, b) => b.total_volume - a.total_volume)
      .slice(0, OI_COIN_COUNT);

    console.log(`OI data is stale (or missing) — refreshing for top ${topByVolume.length} coins by volume:`,
      topByVolume.map(c => c.symbol.toUpperCase()).join(', '));

    const newOiMap = {};
    for (const c of topByVolume) {
      try {
        const result = await fetchOpenInterest(c.cmc_id);
        if (!result) { console.warn(`No OI data for ${c.symbol}`); continue; }
        const prevEntry = oiMap[c.id];
        const oiChangePct = (prevEntry && prevEntry.totalOI)
          ? ((result.totalOI - prevEntry.totalOI) / prevEntry.totalOI) * 100
          : null;
        const priceChangePct = c.price_change_percentage_1h_in_currency;
        newOiMap[c.id] = {
          totalOI: result.totalOI,
          marketPairCount: result.marketPairCount,
          oiChangePct,
          sentiment: interpretOI(oiChangePct, priceChangePct),
          updatedAt: new Date().toISOString()
        };
        console.log(`  ${c.symbol.toUpperCase()}: OI=$${Math.round(result.totalOI).toLocaleString()} (${result.marketPairCount} pairs)${oiChangePct !== null ? ', Δ=' + oiChangePct.toFixed(2) + '%' : ' (first reading)'}`);
      } catch (e) {
        console.warn(`OI fetch failed for ${c.symbol}:`, e.message);
        if (oiMap[c.id]) newOiMap[c.id] = oiMap[c.id]; // keep stale value rather than dropping it
      }
    }
    oiMap = newOiMap;
    oiUpdatedAt = new Date().toISOString();
  } else {
    console.log(`OI data is still fresh (last updated ${oiUpdatedAt}), skipping to save credits.`);
  }

  console.log('Fetching categories from CoinGecko...');
  let categories = (existing && existing.categories) || [];
  try {
    const catRes = await fetchWithTimeout(CATEGORIES_URL, 8000);
    if (catRes.ok) {
      const cats = await catRes.json();
      categories = cats.filter(c => c.market_cap).slice(0, 20);
    } else {
      console.warn('Categories fetch failed: HTTP', catRes.status);
    }
  } catch (e) {
    console.warn('Categories fetch failed, keeping previous data:', e.message);
  }

  // volumeHistory keeps the same { id: { pct, updatedAt } } shape the frontend
  // already expects, just populated instantly from CMC's volume_change_24h
  // instead of a slow per-coin historical scan.
  const volumeMap = {};
  for (const c of coins) {
    if (c.volume_change_24h !== null && c.volume_change_24h !== undefined && !isNaN(c.volume_change_24h)) {
      volumeMap[c.id] = { pct: c.volume_change_24h, updatedAt: new Date().toISOString() };
    }
  }

  const payload = {
    ok: true,
    coins,
    marketUpdatedAt: new Date().toISOString(),
    volumeHistory: volumeMap,
    volumeUpdatedAt: new Date().toISOString(),
    categories,
    categoriesUpdatedAt: new Date().toISOString(),
    openInterest: oiMap,
    oiUpdatedAt
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload));
  console.log('Wrote', outputPath);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
