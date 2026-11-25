# VisionDesk: Real-Time Object Detection (Roboflow Workflow + Vercel)

Aplikasi web deteksi objek (webcam real-time + upload gambar) untuk workflow Roboflow
`marias-workspace-latfm/benda-meja-kelompok-10`. Frontend vanilla HTML/CSS/JS, backend Vercel Serverless Function (Node.js).

## Struktur

```
roboflow-detect/
├── api/detect.js          # Serverless function: proxy ke Roboflow, validasi, timeout, parsing
├── public/
│   ├── index.html         # Dashboard
│   ├── style.css          # Dark theme / electric blue, responsif
│   ├── script.js          # Webcam loop, upload, canvas bounding box, statistik
│   └── assets/favicon.svg
├── test/detect.test.js    # Test offline backend (validasi, error path, parser)
├── dev-server.js          # Server lokal mirip Vercel (tanpa dependency)
├── .env.example
├── package.json
└── vercel.json
```

## Environment Variables

| Nama | Wajib | Keterangan |
|---|---|---|
| `ROBOFLOW_API_KEY` | ya | API key Roboflow. Hanya dipakai di server. |
| `ROBOFLOW_WORKFLOW_URL` | tidak | Override endpoint workflow. |
| `ROBOFLOW_TIMEOUT_MS` | tidak | Timeout ke Roboflow, default 25000. |

## Menjalankan lokal

```bash
cp .env.example .env.local      # isi ROBOFLOW_API_KEY
npm run dev                     # http://localhost:3000
npm test                        # test backend offline
```
Webcam butuh `localhost` atau HTTPS.

## Deploy ke Vercel

```bash
npm i -g vercel
vercel login
vercel link                                     # buat/hubungkan project
vercel env add ROBOFLOW_API_KEY production      # paste key
vercel env add ROBOFLOW_API_KEY preview
vercel --prod
```
Atau: push ke GitHub → Vercel Dashboard → Import Project → Settings → Environment Variables → tambah `ROBOFLOW_API_KEY` → Redeploy.

Verifikasi setelah deploy:
```bash
curl https://<app>.vercel.app/api/detect
# {"ok":true,"service":"detect","configured":true}
```

## API `/api/detect`

- `GET` → health check (`configured` = apakah key ter-set; key tidak pernah dikirim).
- `POST` body `{ "image": "data:image/jpeg;base64,..." }` atau `{ "imageUrl": "https://..." }`.
- Tambah `?debug=1` untuk melihat struktur mentah response Roboflow (string base64 besar disensor).

Response:
```json
{ "predictions": [{ "class": "...", "confidence": 0.9, "x": 0, "y": 0, "width": 0, "height": 0 }],
  "image": { "width": 640, "height": 360 }, "count": 1,
  "modelTimeMs": null, "roundTripMs": 420, "predictionsPath": "outputs[0].<nama_output>.predictions" }
```

### Catatan desain
- **Pengiriman gambar**: frame webcam/upload di-resize di browser (640 px / 1280 px, JPEG) lalu dikirim ke Roboflow sebagai
  input `{"type":"base64"}`, tipe input gambar resmi Roboflow Workflow, bukan Base64 yang disamarkan sebagai URL.
  Input `{"type":"url"}` tetap didukung via `imageUrl`.
- **Parsing**: nama output workflow bergantung pada konfigurasi blok, jadi backend menelusuri `outputs` dan mengambil
  array objek berformat deteksi (`x, y, width, height, class`). Koordinat Roboflow = titik tengah box, diskalakan
  dari dimensi gambar yang dikirim ke resolusi asli.
- **Tanpa overlap request**: frame berikutnya dijadwalkan hanya setelah response sebelumnya selesai (+ interval). Gagal → backoff 3 s.
- **Tanpa memory leak**: Stop Camera menghentikan semua track, melepas `srcObject`, membatalkan request aktif; object URL upload di-revoke.
- Inferensi dijeda otomatis saat tab browser tidak aktif.
