// netlify/functions/get-dashboard-data.js
//
// Called by the frontend (instead of hitting CoinGecko directly).
// Simply reads the pre-computed snapshots that scan-market.js writes to
// Netlify Blobs and returns them as one combined JSON payload.
// This means every visitor shares the same data and the same rate-limit
// budget — the browser never talks to CoinGecko itself.

const { getStore } = require('@netlify/blobs');

function getMarketStore(){
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    return getStore({
      name: 'sonitus-market',
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN
    });
  }
  return getStore('sonitus-market');
}

exports.handler = async () => {
  const store = getMarketStore();

  try {
    const [marketSnapshot, volumeHistory, categoriesSnapshot] = await Promise.all([
      store.get('market-snapshot', { type: 'json' }),
      store.get('volume-history', { type: 'json' }),
      store.get('categories-snapshot', { type: 'json' })
    ]);

    if (!marketSnapshot) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          ok: false,
          error: 'Henüz veri toplanmadı — cron fonksiyonu ilk defa çalışıyor, birkaç saniye sonra tekrar deneyin.'
        })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // short cache so many near-simultaneous visitors don't each trigger a fresh Blobs read
        'Cache-Control': 'public, max-age=15'
      },
      body: JSON.stringify({
        ok: true,
        coins: marketSnapshot.coins,
        marketUpdatedAt: marketSnapshot.updatedAt,
        volumeHistory: (volumeHistory && volumeHistory.map) || {},
        volumeUpdatedAt: volumeHistory && volumeHistory.updatedAt,
        categories: (categoriesSnapshot && categoriesSnapshot.categories) || [],
        categoriesUpdatedAt: categoriesSnapshot && categoriesSnapshot.updatedAt
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
