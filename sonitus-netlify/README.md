# SONITUS — Netlify Kurulumu (Cron + Blobs)

## Klasör yapısı
```
sonitus-netlify/
├── netlify.toml                          ← cron zamanlaması burada tanımlı
├── package.json                          ← @netlify/blobs bağımlılığı
├── netlify/functions/
│   ├── scan-market.js                    ← cron: her 1 dakikada çalışır, veriyi toplar
│   └── get-dashboard-data.js             ← frontend'in okuduğu endpoint
└── public/
    └── index.html                        ← site (artık CoinGecko'ya değil, kendi fonksiyonumuza istek atıyor)
```

## Nasıl çalışıyor
1. **`scan-market.js`** (cron, `netlify.toml` içinde `schedule = "* * * * *"` ile her dakika tetiklenir):
   - Güncel fiyat/piyasa değeri/1s-24s değişim verisini çeker → `market-snapshot` olarak Blobs'a yazar
   - Kategori verisini çeker → `categories-snapshot`
   - 150 coin'lik listeden 12'lik bir dilim alıp gerçek 24s hacim değişimini hesaplar → `volume-history`
   - Bir "cursor" (imleç) tutarak nerede kaldığını hatırlar, her çalıştığında bir sonraki 12'lik gruba geçer
   - Tam bir tur (150 coin) ≈ 13 dakika sürer

2. **`get-dashboard-data.js`**: Blobs'taki 3 veriyi okuyup tek bir JSON olarak frontend'e döner. Kendisi CoinGecko'ya hiç istek atmaz — sadece daha önce toplanmış veriyi sunar.

3. **`public/index.html`**: 30 saniyede bir `get-dashboard-data`'yı çağırır (bu ucuz bir okuma, rate limit sorunu yaratmaz).

## Deploy adımları
1. Bu klasörü bir GitHub reposuna push'la (veya Netlify CLI ile `netlify deploy` yap)
2. Netlify'da "Add new site" → repoyu bağla
3. Build ayarları zaten `netlify.toml`'da tanımlı, ekstra bir şey yapmana gerek yok
4. Netlify otomatik olarak Blobs'u aktif eder (ek bir hesap/kurulum gerekmez)
5. Deploy tamamlandıktan sonra cron fonksiyonu otomatik başlar — ilk birkaç dakika `market-snapshot` boş olabilir, bu normal

## CoinMarketCap'e geçiş (ileride)
`scan-market.js` içindeki `MARKETS_URL` ve `fetchVolumeChangeForCoin` fonksiyonundaki URL'leri CMC endpoint'leriyle değiştirip, CMC API key'ini Netlify'ın **Environment Variables** kısmına ekleyip `process.env.CMC_API_KEY` ile okumak yeterli. Frontend hiç değişmeyecek çünkü o zaten sadece bizim `get-dashboard-data` fonksiyonumuzu çağırıyor.

## Yerel test (Netlify CLI ile)
```bash
npm install
npx netlify dev
```
Not: Scheduled function'lar yerelde otomatik tetiklenmez; `netlify functions:invoke scan-market` ile manuel çalıştırabilirsin.
