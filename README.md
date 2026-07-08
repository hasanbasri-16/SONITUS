# SONITUS — GitHub Actions + Netlify (tamamen ücretsiz mimari)

## Neden bu yapı?
Netlify'ın Functions/Blobs kullanımı kredi tüketiyor. Bu yapıda veri toplama işini
tamamen **GitHub Actions**'a taşıdık (ücretsiz, cömert limitler), Netlify ise
sadece statik dosyaları sunuyor — bu da Netlify tarafında neredeyse sıfır kredi
tüketimi demek.

## Klasör yapısı
```
sonitus-netlify/
├── netlify.toml                     ← sadece publish dizinini tanımlıyor, fonksiyon yok
├── package.json
├── .github/workflows/
│   └── scan-market.yml              ← cron: her 5 dakikada bir çalışır
├── scripts/
│   └── scan-market.js               ← CoinGecko'yu tarayıp data/dashboard-data.json üretir
└── public/
    └── index.html                   ← site; veriyi GitHub'ın raw CDN'inden okur
```

## Nasıl çalışıyor
1. **`.github/workflows/scan-market.yml`** her 5 dakikada bir tetiklenir.
2. **`scripts/scan-market.js`** çalışır: güncel fiyat/mcap verisini, kategori verisini
   ve 150 coin'in gerçek 24s hacim değişimini hesaplar (tek seferde, ~3 dakikada —
   GitHub Actions'ın süre limiti Netlify Functions'tan çok daha geniş olduğu için
   artık "cursor/batch" mantığına gerek kalmadı).
3. Sonuç `data/dashboard-data.json` olarak **`data` adlı ayrı bir branch'e** commit edilip
   push'lanır (site kodunun olduğu `main` branch'ine DEĞİL — böylece her veri
   güncellemesi Netlify'da yeni bir deploy tetiklemez).
4. **`public/index.html`** bu dosyayı doğrudan
   `https://raw.githubusercontent.com/KULLANICI/REPO/data/data/dashboard-data.json`
   adresinden okur. Bu, GitHub'ın kendi CDN'i olduğu için ücretsiz ve hızlı.

## ⚠️ Tek seferlik kurulum: `data` branch'ini oluştur
Workflow ilk çalıştığında `data` branch'inin **zaten var olmasını** bekliyor. Bunu
bir kere elle oluşturman gerekiyor:

```bash
git checkout --orphan data
git rm -rf .
mkdir data
echo '{"ok":false,"coins":[],"volumeHistory":{},"categories":[]}' > data/dashboard-data.json
git add data/dashboard-data.json
git commit -m "İlk veri dosyası"
git push origin data
git checkout main
```

## Repo'yu public yapma
GitHub raw dosyaları private repo'larda tarayıcıdan doğrudan okunamaz (auth gerekir).
Bu yüzden repo'nun **public** olması gerekiyor:
Repo → **Settings → General → Danger Zone → Change visibility → Make public**.

> Not: Kodda hiçbir gizli bilgi (API key vs.) yok, CoinMarketCap key'i ileride eklenirse
> GitHub Actions'ın **Secrets** özelliğiyle saklanacak, koda hiç yazılmayacak — o yüzden
> public yapmak güvenlik açısından risksiz.

## `public/index.html` içindeki repo bilgisini güncelle
`DATA_URL_BASE` değişkeni şu an `hasanbasri-16/SONITUS` reposuna göre ayarlı. Farklı bir
kullanıcı adı/repo adı kullanıyorsan bu satırı güncelle:
```js
const DATA_URL_BASE = 'https://raw.githubusercontent.com/KULLANICI_ADIN/REPO_ADIN/data/data/dashboard-data.json';
```

## Deploy adımları
1. Bu klasörü GitHub reposunun **köküne** push'la (Actions dosyası `.github/workflows/`
   klasöründe olmalı, GitHub bunu otomatik algılar)
2. `data` branch'ini yukarıdaki komutlarla oluştur
3. Repo'yu public yap
4. Netlify'da **Base directory** ve **Publish directory** ayarlarını temizle
   (artık ekstra ayara gerek yok, `netlify.toml` her şeyi tanımlıyor — sadece `public`)
5. Netlify → **Trigger deploy**
6. GitHub → **Actions** sekmesinden workflow'u elle bir kere tetikle (`Run workflow` butonu,
   `workflow_dispatch` sayesinde bunu yapabiliyoruz) — ilk veriyi hemen üretmek için,
   5 dakikayı beklemene gerek yok

## Eski Netlify Functions/Blobs kurulumunu temizleme
Eğer daha önce Netlify'da `BLOBS_SITE_ID` / `BLOBS_TOKEN` environment variable'larını
eklediysen, artık kullanılmıyorlar — istersen Site settings → Environment variables'tan
silebilirsin (zararı yok ama gereksizler).

## CoinMarketCap'e geçiş (ileride)
`scripts/scan-market.js` içindeki URL'leri CMC endpoint'leriyle değiştir, API key'i
GitHub reposunun **Settings → Secrets and variables → Actions** kısmına ekle, workflow
dosyasında `env:` altında script'e ilet (`process.env.CMC_API_KEY` ile okunur).
Frontend hiç değişmeyecek.
