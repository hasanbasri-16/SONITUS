// scripts/scan-market.js
//
// Runs inside a GitHub Actions scheduled workflow (every 5 minutes).
// Unlike a serverless function, a GitHub Actions job has a generous time
// budget, so we scan ALL tracked coins' volume history in a single run
// (no cursor/batching needed) — much simpler than the old Netlify version.
//
// Usage: node scripts/scan-market.js <output-file-path>

const fs = require('fs');
const path = require('path');

const TRACK_COUNT = 100;
const REQUEST_SPACING_MS = 2000; // pacing between per-coin requests to respect CoinGecko's free rate limit
const PER_COIN_TIMEOUT_MS = 8000;

const MARKETS_URL = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${TRACK_COUNT}&page=1&price_change_percentage=1h,24h`;
const CATEGORIES_URL = 'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc';

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

async function fetchVolumeChangeForCoin(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=2`;
  const res = await fetchWithTimeout(url, PER_COIN_TIMEOUT_MS);
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  const data = await res.json();
  const vols = data.total_volumes;
  if (!vols || vols.length < 2) return null;
  const now = vols[vols.length - 1];
  const targetTs = Date.now() - 24 * 3600 * 1000;
  let closest = vols[0], minDiff = Infinity;
  for (const point of vols) {
    const diff = Math.abs(point[0] - targetTs);
    if (diff < minDiff) { minDiff = diff; closest = point; }
  }
  if (!closest || !closest[1]) return null;
  return ((now[1] - closest[1]) / closest[1]) * 100;
}

// Load whatever was written last time, so if a coin fails this run we keep its previous value
function loadExisting(outputPath) {
  try {
    const raw = fs.readFileSync(outputPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function main() {
  const existing = loadExisting(outputPath);
  const volumeMap = (existing && existing.volumeHistory) || {};

  console.log('Fetching market snapshot...');
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

  console.log('Scanning volume history for tracked coins...');
  const ids = coins.slice(0, TRACK_COUNT).map(c => c.id);
  let ok = 0, failed = 0;
  for (const id of ids) {
    try {
      const pct = await fetchVolumeChangeForCoin(id);
      volumeMap[id] = { pct, updatedAt: new Date().toISOString() };
      ok++;
    } catch (e) {
      failed++;
      if (e.message === 'RATE_LIMIT') {
        console.warn(`Rate limited on ${id}, backing off 10s...`);
        await sleep(10000);
      } else {
        console.warn(`Failed on ${id}: ${e.message}`);
      }
      // keep previous value for this coin if any
    }
    await sleep(REQUEST_SPACING_MS);
  }
  console.log(`Volume scan done: ${ok} ok, ${failed} failed.`);

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
