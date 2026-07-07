// netlify/functions/scan-market.js
//
// Scheduled (cron) function — runs every minute (see netlify.toml).
// Responsibilities each run:
//   1. Refresh the "current market snapshot" (price, market cap, 1h/24h change,
//      current 24h volume) for the top N coins — cheap, 1 API call.
//   2. Advance an incremental scan of REAL 24h volume-change history.
//      Serverless functions have a short execution window (~10s on most plans),
//      so instead of scanning all coins every run, we scan a small batch each
//      minute and remember where we left off (the "cursor") in Blobs.
//      A full pass over TRACK_COUNT coins takes TRACK_COUNT/BATCH_SIZE minutes.
//
// All results are written to Netlify Blobs so every visitor reads the same
// pre-computed data instead of each browser hitting CoinGecko itself.

const { getStore } = require('@netlify/blobs');

const TRACK_COUNT = 150;      // how many top-mcap coins we keep real volume history for
const BATCH_SIZE = 12;        // coins processed per cron run (stays within function timeout)
const PER_COIN_TIMEOUT_MS = 6000;

const MARKETS_URL = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${TRACK_COUNT}&page=1&price_change_percentage=1h,24h`;
const CATEGORIES_URL = 'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc';

function fetchWithTimeout(url, ms){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchVolumeChangeForCoin(id){
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=2`;
  const res = await fetchWithTimeout(url, PER_COIN_TIMEOUT_MS);
  if(res.status === 429) throw new Error('RATE_LIMIT');
  if(!res.ok) throw new Error('HTTP_' + res.status);
  const data = await res.json();
  const vols = data.total_volumes;
  if(!vols || vols.length < 2) return null;
  const now = vols[vols.length - 1];
  const targetTs = Date.now() - 24 * 3600 * 1000;
  let closest = vols[0], minDiff = Infinity;
  for(const point of vols){
    const diff = Math.abs(point[0] - targetTs);
    if(diff < minDiff){ minDiff = diff; closest = point; }
  }
  if(!closest || !closest[1]) return null;
  return ((now[1] - closest[1]) / closest[1]) * 100;
}

exports.handler = async () => {
  const store = getStore('sonitus-market');
  const log = [];

  try {
    // ---- Step 1: refresh current market snapshot (always, every run) ----
    const marketsRes = await fetchWithTimeout(MARKETS_URL, 8000);
    if(!marketsRes.ok) throw new Error('markets fetch failed: HTTP ' + marketsRes.status);
    const coins = await marketsRes.json();

    await store.setJSON('market-snapshot', {
      coins,
      updatedAt: new Date().toISOString()
    });
    log.push(`market-snapshot updated: ${coins.length} coins`);

    // ---- Step 2: refresh categories (cheap, do it every run too) ----
    try {
      const catRes = await fetchWithTimeout(CATEGORIES_URL, 6000);
      if(catRes.ok){
        const categories = await catRes.json();
        await store.setJSON('categories-snapshot', {
          categories: categories.filter(c => c.market_cap).slice(0, 20),
          updatedAt: new Date().toISOString()
        });
        log.push('categories-snapshot updated');
      }
    } catch(e) {
      log.push('categories fetch skipped: ' + e.message);
    }

    // ---- Step 3: incremental volume-history scan ----
    let cursor = 0;
    try {
      const cursorData = await store.get('scan-cursor', { type: 'json' });
      if(cursorData && typeof cursorData.cursor === 'number') cursor = cursorData.cursor;
    } catch(e) { /* no cursor yet, start at 0 */ }

    let volumeMap = {};
    try {
      const existing = await store.get('volume-history', { type: 'json' });
      if(existing && existing.map) volumeMap = existing.map;
    } catch(e) { /* first run, empty map */ }

    const ids = coins.slice(0, TRACK_COUNT).map(c => c.id);
    const batchIds = [];
    for(let i = 0; i < BATCH_SIZE && ids.length > 0; i++){
      batchIds.push(ids[(cursor + i) % ids.length]);
    }

    for(const id of batchIds){
      try {
        const pct = await fetchVolumeChangeForCoin(id);
        volumeMap[id] = { pct, updatedAt: new Date().toISOString() };
      } catch(e) {
        log.push(`volume fetch failed for ${id}: ${e.message}`);
        // keep previous value for this coin, just skip
      }
    }

    const nextCursor = (cursor + BATCH_SIZE) % Math.max(ids.length, 1);
    await store.setJSON('scan-cursor', { cursor: nextCursor });
    await store.setJSON('volume-history', { map: volumeMap, updatedAt: new Date().toISOString() });
    log.push(`volume batch done: processed ${batchIds.length} coins, cursor now ${nextCursor}/${ids.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, log })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message, log })
    };
  }
};
