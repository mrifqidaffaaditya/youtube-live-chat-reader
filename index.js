require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const googleTTS = require('google-tts-api');
const { Masterchat, runsToString } = require('masterchat');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 25522;
const TTS_LANG = process.env.TTS_LANG || 'id';
const TTS_MAX_LENGTH = parseInt(process.env.TTS_MAX_LENGTH) || 200;
const CACHE_TIMEOUT = parseInt(process.env.CACHE_TIMEOUT) || 300000;

app.use(express.static('public'));

// ─── Endpoint & Cache untuk dukungan Lavalink Streaming ───────────────────────
const audioCache = new Map();

// FIX: Validasi format audioId untuk mencegah path traversal
app.get('/audio/:id.mp3', (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).send('Invalid audio ID');
    }
    const audioBuffer = audioCache.get(id);
    if (!audioBuffer) {
        return res.status(404).send('Audio not found or expired');
    }
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
});

// ─── Helper: Ekstrak videoId dari URL atau input langsung ─────────────────────
function parseVideoId(input) {
    input = input.trim();
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const pat of patterns) {
        const m = input.match(pat);
        if (m) return m[1];
    }
    return null;
}

// ─── Shared: Proses chat → TTS → emit ke client ───────────────────────────────
async function handleChatEvent(socket, { username, comment, isSuperChat, amount, lang, maxLength }) {
    console.log(`[CHAT] ${isSuperChat ? '💛 SUPERCHAT ' : ''}${username}: ${comment}`);

    let audioBase64 = null;
    let audioUrl = null;
    const currentLang = lang || TTS_LANG;
    const currentMaxLength = maxLength || TTS_MAX_LENGTH;

    try {
        let textToSpeak;
        if (isSuperChat && amount) {
            textToSpeak = `Super Chat dari ${username}, ${amount}${comment ? `, berkata, ${comment}` : ''}`;
        } else {
            textToSpeak = `${username} berkata, ${comment}`;
        }

        audioBase64 = await googleTTS.getAudioBase64(
            textToSpeak.substring(0, currentMaxLength),
            { lang: currentLang, slow: false, host: 'https://translate.google.com', timeout: 10000 }
        );
        
        if (audioBase64) {
            const audioId = Date.now() + '-' + Math.round(Math.random() * 10000);
            audioCache.set(audioId, Buffer.from(audioBase64, 'base64'));
            // Hapus cache sesuai timeout yang dikonfigurasi agar memori tidak penuh
            setTimeout(() => {
                audioCache.delete(audioId);
            }, CACHE_TIMEOUT);
            audioUrl = `/audio/${audioId}.mp3`;
        }
    } catch (ttsErr) {
        console.error(`[TTS Error] ${ttsErr.message}`);
    }

    socket.emit('chat', {
        username,
        comment,
        isSuperChat: !!isSuperChat,
        amount: amount || null,
        audioData: audioBase64 ? `data:audio/mp3;base64,${audioBase64}` : null,
        audioUrl: audioUrl,
    });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[INFO] Client terhubung: ${socket.id}`);

    /** @type {import('masterchat').Masterchat | null} */
    let mc = null;

    const stopListening = () => {
        if (mc) {
            const currentMc = mc;
            mc = null;
            try {
                currentMc.removeAllListeners();
                currentMc.stop();
            } catch (e) {
                // Abaikan error saat stop (misal: sudah stopped)
            }
            console.log(`[INFO] Masterchat dihentikan untuk ${socket.id}`);
        }
    };

    socket.on('set-video', async (input) => {
        // FIX: Validasi input
        if (!input || (typeof input !== 'string' && typeof input !== 'object')) {
            socket.emit('sys-message', '❌ Input tidak valid.');
            return;
        }
        console.log(`[INFO] Input diterima:`, input);
        stopListening();

        let videoIdRaw = input;
        let customLang = TTS_LANG;
        let customMaxLength = TTS_MAX_LENGTH;

        // Mendukung input berupa object untuk opsi yang lebih dinamis
        if (typeof input === 'object' && input !== null) {
            videoIdRaw = input.videoId || input.url;
            if (input.lang) customLang = input.lang;
            if (input.maxLength) customMaxLength = input.maxLength;
        }

        const videoId = parseVideoId(String(videoIdRaw || ''));
        if (!videoId) {
            socket.emit('sys-message', '❌ Format URL/Video ID tidak dikenali.');
            socket.emit('sys-error', 'Video ID tidak valid.');
            return;
        }

        socket.emit('sys-message', `⏳ Menghubungkan ke live stream...`);

        try {
            // Masterchat tidak butuh API key — scrape langsung dari YouTube
            mc = new Masterchat(videoId, '', { mode: 'live' });

            // Ambil metadata (judul) — opsional, untuk log & konfirmasi
            await mc.populateMetadata();
            const title = mc.title || videoId;
            console.log(`[BERHASIL] Terhubung ke: "${title}" (${videoId})`);
            socket.emit('sys-message', `✅ Terhubung! Memantau: ${title}`);

            // ── Chat biasa ───────────────────────────────────────────────────
            mc.on('chat', async (action) => {
                if (action.type !== 'addChatItemAction') return;
                const username = (action.authorName || 'Anonim').replace(/^@/, '');
                const comment = action.message ? runsToString(action.message) : '';
                if (!comment) return;
                await handleChatEvent(socket, { username, comment, isSuperChat: false, lang: customLang, maxLength: customMaxLength });
            });

            // ── Super Chat ───────────────────────────────────────────────────
            mc.on('actions', async (actions) => {
                for (const action of actions) {
                    if (action.type === 'addSuperChatItemAction') {
                        const username = (action.authorName || 'Anonim').replace(/^@/, '');
                        const comment = action.message ? runsToString(action.message) : '';
                        const amount = action.superchat?.amount
                            ? `${action.superchat.currency} ${action.superchat.amount}`
                            : null;
                        await handleChatEvent(socket, { username, comment, isSuperChat: true, amount, lang: customLang, maxLength: customMaxLength });
                    }
                }
            });

            // ── Live berakhir ────────────────────────────────────────────────
            mc.on('end', (reason) => {
                console.log(`[INFO] Live berakhir: ${reason}`);
                socket.emit('sys-message', `⚠️ Live berakhir${reason ? ': ' + reason : '.'}`);
                stopListening();
            });

            // ── Error ────────────────────────────────────────────────────────
            mc.on('error', (err) => {
                console.error(`[ERROR] Masterchat:`, err.message);
                socket.emit('sys-message', `❌ Error: ${err.message}`);
                socket.emit('sys-error', err.message);
            });

            // Mulai listen live chat
            mc.listen();

        } catch (err) {
            console.error(`[GAGAL] ${err.message}`);
            socket.emit('sys-message', `❌ Gagal: ${err.message}`);
            socket.emit('sys-error', err.message);
            mc = null;
        }
    });

    socket.on('stop', () => {
        stopListening();
        socket.emit('sys-message', '⏹️ Pemantauan dihentikan.');
    });

    socket.on('disconnect', () => {
        console.log(`[INFO] Client terputus: ${socket.id}`);
        stopListening();
    });
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('[Shutdown] Menutup server...');
    io.close();
    server.close();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.error('[Unhandled Rejection]', err);
});

server.listen(PORT, () => {
    console.log(`\n✅ Server berjalan di http://localhost:${PORT}`);
    console.log(`   Tidak butuh API Key — powered by masterchat.\n`);
});