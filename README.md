# YT Live Chat TTS Reader

Sebuah server Socket.io & HTTP ringan untuk membacakan live chat YouTube secara otomatis menggunakan Google TTS.  
Sangat fleksibel, bisa digunakan sebagai **Widget OBS**, **sumber Stream Lavalink**, atau digabungkan ke bot Discord Anda.
**Tidak perlu API Key** — menggunakan [masterchat](https://github.com/nicholasgasior/masterchat) untuk *scrape* langsung dari YouTube.

---

## ⚡ Fitur Utama

- **Real-time Live Chat**: Mendapatkan pesan obrolan YouTube langsung tanpa menggunakan API Key.
- **Audio TTS Bawaan**: Membacakan pesan menggunakan Google TTS secara otomatis (mendukung Super Chat secara khusus!).
- **Dukungan Lavalink**: Otomatis menghasilkan endpoint `.mp3` dinamis untuk dimainkan oleh Bot Discord menggunakan Lavalink.
- **Widget OBS**: Tampilan widget browser yang bersih dan simpel dengan background transparan.
- **Fleksibel**: Pengaturan dapat dikonfigurasi melalui `.env` untuk bahasa, kecepatan TTS, maksimal panjang karakter, hingga batas caching Lavalink.

---

## 🛠️ Setup

1. **Install dependensi**
   ```bash
   npm install
   ```
2. **Konfigurasi Lingkungan (Opsional)**
   Buat file `.env` (kamu bisa menyalin dari `.env.example`):
   ```env
   PORT=25522
   TTS_LANG=id             # Bahasa TTS (contoh: id, en, ja)
   TTS_MAX_LENGTH=200      # Batas karakter teks TTS
   CACHE_TIMEOUT=300000    # Waktu cache untuk audio stream (dalam milidetik, default 5 menit)
   ```
3. **Jalankan Server**
   ```bash
   npm start
   ```

Server akan langsung jalan di `http://localhost:25522`.

---

## 🎬 Cara Pakai

### Di Browser (untuk test / input manual)
Buka `http://localhost:25522`, masukkan URL atau Video ID live stream → **Mulai**.

### Di OBS (sebagai widget overlay)
1. Tambahkan **Browser Source** di scene OBS kamu.
2. URL: `http://localhost:25522?obs=1&v=VIDEO_ID`  
   *(Ganti `VIDEO_ID` dengan ID live stream. Parameter `?obs=1` menyembunyikan control panel input)*
3. Width: `520` | Height: `400` | ✅ Transparent background

### Integrasi dengan Bot Discord (Lavalink)
Gunakan *client* Socket.io pada Bot Discord Anda dan sambungkan ke server ini.
```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:25522');

// Minta server memantau video YouTube tertentu
socket.emit('set-video', 'VIDEO_ID_ATAU_URL_LIVE_YOUTUBE');

socket.on('chat', (data) => {
    // Putar di Lavalink menggunakan URL stream dari aplikasi ini
    if (data.audioUrl) {
        const streamUrl = `http://localhost:25522${data.audioUrl}`;
        // Contoh: player.play(streamUrl);
    }
});
```
*Tip: Anda juga bisa memberikan pengaturan dinamis per-koneksi dengan mengirimkan object ke `set-video`:*
```javascript
socket.emit('set-video', { 
    videoId: 'VIDEO_ID_ATAU_URL_LIVE_YOUTUBE', 
    lang: 'en', 
    maxLength: 100 
});
```

---

## 📁 Format Input yang Didukung

- `https://www.youtube.com/watch?v=XXXXXXXXXXX`
- `https://www.youtube.com/live/XXXXXXXXXXX`
- `https://youtu.be/XXXXXXXXXXX`
- Video ID langsung: `XXXXXXXXXXX`