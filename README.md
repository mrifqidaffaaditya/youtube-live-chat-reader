# YT Live Chat TTS Reader

Widget OBS untuk membacakan live chat YouTube menggunakan Google TTS.  
**Tidak perlu API Key** — menggunakan [masterchat](https://github.com/nicholasgasior/masterchat) untuk scrape langsung.

---

## ⚡ Setup

```bash
npm install
npm start
```

Server langsung jalan di `http://localhost:25522`. Tidak ada konfigurasi tambahan.

---

## 🎬 Cara Pakai

### Di Browser (untuk test / input manual)
Buka `http://localhost:25522`, masukkan URL atau Video ID live stream → **Mulai**.

### Di OBS (widget overlay)
1. Tambahkan **Browser Source**
2. URL: `http://localhost:25522?obs=1`  
   _(parameter `?obs=1` menyembunyikan control panel input)_
3. Width: `520` | Height: `400` | ✅ Transparent background

Format input yang didukung:
- `https://www.youtube.com/watch?v=XXXXXXXXXXX`
- `https://www.youtube.com/live/XXXXXXXXXXX`
- `https://youtu.be/XXXXXXXXXXX`
- Video ID langsung: `XXXXXXXXXXX`

---

## 🔄 Perbandingan dengan versi TikTok

| Aspek | TikTok (versi lama) | YouTube (versi ini) |
|-------|---------------------|---------------------|
| Library | `tiktok-live-connector` | `masterchat` |
| API Key | ❌ Tidak perlu | ❌ Tidak perlu |
| Koneksi | WebSocket langsung | Scrape via HTTP |
| Latensi | ~1 detik | ~3–5 detik |
| Super Chat | ❌ | ✅ Terdeteksi khusus |
| Struktur kode | Mirip 1:1 | Mirip 1:1 |

---

## 📁 Struktur File

```
yt-tts-livechat/
├── server.js        # Server utama
├── .env             # Konfigurasi port
├── package.json
└── public/
    └── index.html   # Widget OBS
```