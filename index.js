require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const googleTTS = require('google-tts-api');
const { Masterchat, runsToString } = require('masterchat');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Konstanta & Validasi Config ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 25522;

// FIX: Validasi TTS_LANG — hanya izinkan kode bahasa yang valid (2-5 karakter alfanumerik dan dash)
const _rawLang = process.env.TTS_LANG || 'id';
const TTS_LANG = /^[a-z]{2,5}(-[A-Z]{2})?$/.test(_rawLang) ? _rawLang : 'id';

// FIX: Validasi TTS_MAX_LENGTH — harus angka positif dan wajar
const _rawMaxLen = parseInt(process.env.TTS_MAX_LENGTH);
const TTS_MAX_LENGTH = (!isNaN(_rawMaxLen) && _rawMaxLen > 0 && _rawMaxLen <= 500) ? _rawMaxLen : 200;

// FIX: Validasi CACHE_TIMEOUT — harus angka positif
const _rawCacheTimeout = parseInt(process.env.CACHE_TIMEOUT);
const CACHE_TIMEOUT = (!isNaN(_rawCacheTimeout) && _rawCacheTimeout > 0) ? _rawCacheTimeout : 300000;

// Batas panjang maksimum
const MAX_STREAM_KEY_LENGTH = 100;
const MAX_COMMENT_LENGTH = 300;
const MAX_USERNAME_LENGTH = 100;

// Daftar kode bahasa yang diizinkan untuk TTS (subset aman)
const ALLOWED_LANGS = new Set([
    'id', 'en', 'ja', 'ko', 'zh-CN', 'zh-TW', 'fr', 'de', 'es', 'pt', 'ru', 'ar', 'hi', 'th', 'vi', 'ms'
]);

app.use(express.static('public'));

// ─── Endpoint Audio (Lavalink Streaming) ─────────────────────────────────────
const audioCache = new Map();

app.get('/audio/:id.mp3', (req, res) => {
    const id = req.params.id;
    // FIX: Validasi ketat format audioId
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).send('Invalid audio ID');
    }
    const audioBuffer = audioCache.get(id);
    if (!audioBuffer) {
        return res.status(404).send('Audio not found or expired');
    }
    res.set('Content-Type', 'audio/mpeg');
    // FIX: Header keamanan tambahan
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    res.send(audioBuffer);
});

// ─── Helper Sanitasi ──────────────────────────────────────────────────────────

/**
 * Sanitasi stream key dari query param ?stream=
 * Hanya izinkan karakter aman (alfanumerik, _, -, .)
 */
function sanitizeStreamKey(raw) {
    if (!raw || typeof raw !== 'string') return '*';
    const cleaned = raw.trim().substring(0, MAX_STREAM_KEY_LENGTH);
    if (!/^[a-zA-Z0-9_.\-*]+$/.test(cleaned)) return '*';
    return cleaned;
}

/**
 * Sanitasi string umum — hapus karakter kontrol dan batasi panjang.
 */
function sanitizeString(str, maxLen = 300) {
    if (typeof str !== 'string') return '';
    return str.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').substring(0, maxLen);
}

/**
 * Validasi bahasa TTS — harus ada di whitelist.
 */
function validateLang(lang) {
    if (!lang || typeof lang !== 'string') return TTS_LANG;
    const clean = lang.trim();
    return ALLOWED_LANGS.has(clean) ? clean : TTS_LANG;
}

/**
 * Validasi maxLength dari input — harus angka positif dan tidak melebihi batas.
 */
function validateMaxLength(val) {
    const n = parseInt(val);
    if (isNaN(n) || n <= 0 || n > 500) return TTS_MAX_LENGTH;
    return n;
}

// ─── Plain WebSocket Server ───────────────────────────────────────────────────
// Path: ws://localhost:<PORT>/ws/chat
// Path dengan filter sesi: ws://localhost:<PORT>/ws/chat?stream=<videoId>
const wss = new WebSocketServer({ noServer: true });

const wsSessionMap = new Map();

// FIX: Rate limiting koneksi WS per IP
const WS_MAX_CONNECTIONS_PER_IP = 10;
const wsIpCount = new Map();

function addWsClient(ws, streamKey) {
    if (!wsSessionMap.has(streamKey)) {
        wsSessionMap.set(streamKey, new Set());
    }
    wsSessionMap.get(streamKey).add(ws);
}

function removeWsClient(ws, streamKey) {
    const set = wsSessionMap.get(streamKey);
    if (set) {
        set.delete(ws);
        if (set.size === 0) wsSessionMap.delete(streamKey);
    }
}

// FIX: Gunakan 'http://localhost' sebagai base — cegah Host header injection
server.on('upgrade', (request, socket, head) => {
    let pathname, streamParam;
    try {
        const url = new URL(request.url, 'http://localhost');
        pathname = url.pathname;
        streamParam = url.searchParams.get('stream');
    } catch (e) {
        socket.destroy();
        return;
    }

    if (pathname === '/ws/chat') {
        const ip = request.socket.remoteAddress || 'unknown';
        const currentCount = wsIpCount.get(ip) || 0;
        if (currentCount >= WS_MAX_CONNECTIONS_PER_IP) {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            socket.destroy();
            return;
        }
        wsIpCount.set(ip, currentCount + 1);

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws._streamKey = sanitizeStreamKey(streamParam);
            ws._ip = ip;
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    const streamKey = ws._streamKey;
    const ip = ws._ip || 'unknown';
    console.log(`[WS] Client terhubung: ${ip} (stream: ${streamKey})`);
    addWsClient(ws, streamKey);

    // FIX: try/catch pada ws.send() awal
    try {
        ws.send(JSON.stringify({
            type: 'connected',
            message: 'YouTube Live Chat WebSocket ready.',
            stream: streamKey === '*' ? 'all' : streamKey
        }));
    } catch (e) {
        // Abaikan
    }

    ws.on('close', () => {
        console.log(`[WS] Client terputus: ${ip} (stream: ${streamKey})`);
        removeWsClient(ws, streamKey);
        const count = wsIpCount.get(ip) || 1;
        if (count <= 1) wsIpCount.delete(ip);
        else wsIpCount.set(ip, count - 1);
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error client ${ip}:`, err.message);
        removeWsClient(ws, streamKey);
        const count = wsIpCount.get(ip) || 1;
        if (count <= 1) wsIpCount.delete(ip);
        else wsIpCount.set(ip, count - 1);
    });
});

/**
 * Broadcast chat event ke WS client yang subscribe stream tertentu + client '*'.
 */
function broadcastToWsClients(payload, streamKey) {
    let data;
    try {
        data = JSON.stringify(payload);
    } catch (e) {
        console.error('[WS] Gagal serialize payload:', e.message);
        return;
    }

    const sendSafe = (ws) => {
        if (ws.readyState === ws.OPEN) {
            try { ws.send(data); } catch (e) { /* Abaikan */ }
        }
    };

    const specificClients = wsSessionMap.get(streamKey);
    if (specificClients) {
        for (const ws of specificClients) sendSafe(ws);
    }

    const allClients = wsSessionMap.get('*');
    if (allClients) {
        for (const ws of allClients) sendSafe(ws);
    }
}

// ─── Helper: Ekstrak videoId dari URL atau input langsung ─────────────────────
function parseVideoId(input) {
    if (typeof input !== 'string') return null;
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
async function handleChatEvent(socket, { username, comment, isSuperChat, amount, lang, maxLength, videoId }) {
    // FIX: Sanitasi semua input sebelum diproses
    const safeUsername = sanitizeString(username, MAX_USERNAME_LENGTH);
    const safeComment = sanitizeString(comment, MAX_COMMENT_LENGTH);
    const safeAmount = amount ? sanitizeString(String(amount), 50) : null;
    // FIX: Validasi lang dan maxLength — cegah inject ke Google TTS
    const currentLang = validateLang(lang);
    const currentMaxLength = validateMaxLength(maxLength);

    if (!safeComment) return; // Jangan proses komentar kosong

    console.log(`[CHAT] ${isSuperChat ? '💛 SUPERCHAT ' : ''}${safeUsername}: ${safeComment}`);

    let audioBase64 = null;
    let audioUrl = null;

    try {
        let textToSpeak;
        if (isSuperChat && safeAmount) {
            textToSpeak = `Super Chat dari ${safeUsername}, ${safeAmount}${safeComment ? `, berkata, ${safeComment}` : ''}`;
        } else {
            textToSpeak = `${safeUsername} berkata, ${safeComment}`;
        }

        audioBase64 = await googleTTS.getAudioBase64(
            textToSpeak.substring(0, currentMaxLength),
            { lang: currentLang, slow: false, host: 'https://translate.google.com', timeout: 10000 }
        );

        if (audioBase64) {
            // FIX: Gunakan crypto.randomBytes() untuk ID yang lebih kuat
            const audioId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
            audioCache.set(audioId, Buffer.from(audioBase64, 'base64'));
            setTimeout(() => { audioCache.delete(audioId); }, CACHE_TIMEOUT);
            audioUrl = `/audio/${audioId}.mp3`;
        }
    } catch (ttsErr) {
        console.error(`[TTS Error] ${sanitizeString(ttsErr.message, 200)}`);
    }

    // FIX: Payload hanya berisi data yang sudah disanitasi
    const chatPayload = {
        type: 'chat',
        platform: 'youtube',
        stream: videoId || null,
        username: safeUsername,
        comment: safeComment,
        isSuperChat: !!isSuperChat,
        amount: safeAmount,
        audioUrl,
    };

    socket.emit('chat', {
        username: safeUsername,
        comment: safeComment,
        isSuperChat: !!isSuperChat,
        amount: safeAmount,
        audioData: audioBase64 ? `data:audio/mp3;base64,${audioBase64}` : null,
        audioUrl,
    });

    if (videoId) {
        broadcastToWsClients(chatPayload, videoId);
    }
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
                // Abaikan error saat stop
            }
            console.log(`[INFO] Masterchat dihentikan untuk ${socket.id}`);
        }
    };

    socket.on('set-video', async (input) => {
        // FIX: Validasi tipe input secara ketat
        if (!input || (typeof input !== 'string' && (typeof input !== 'object' || Array.isArray(input)))) {
            socket.emit('sys-message', '❌ Input tidak valid.');
            return;
        }
        stopListening();

        let videoIdRaw = input;
        let customLang = TTS_LANG;
        let customMaxLength = TTS_MAX_LENGTH;

        if (typeof input === 'object' && input !== null) {
            videoIdRaw = input.videoId || input.url;
            // FIX: Validasi lang dan maxLength dari object input
            if (input.lang) customLang = validateLang(input.lang);
            if (input.maxLength) customMaxLength = validateMaxLength(input.maxLength);
        }

        const videoId = parseVideoId(String(videoIdRaw || ''));
        if (!videoId) {
            socket.emit('sys-message', '❌ Format URL/Video ID tidak dikenali.');
            socket.emit('sys-error', 'Video ID tidak valid.');
            return;
        }

        console.log(`[INFO] Memantau video: ${videoId}`);
        socket.emit('sys-message', `⏳ Menghubungkan ke live stream...`);

        try {
            mc = new Masterchat(videoId, '', { mode: 'live' });

            await mc.populateMetadata();
            // FIX: Sanitasi title dari YouTube sebelum di-log/emit
            const title = sanitizeString(mc.title || videoId, 200);
            console.log(`[BERHASIL] Terhubung ke: "${title}" (${videoId})`);
            socket.emit('sys-message', `✅ Terhubung! Memantau: ${title}`);

            mc.on('chat', async (action) => {
                if (action.type !== 'addChatItemAction') return;
                // FIX: Sanitasi username dari YouTube
                const username = sanitizeString(
                    (action.authorName || 'Anonim').replace(/^@/, ''),
                    MAX_USERNAME_LENGTH
                );
                const comment = action.message ? sanitizeString(runsToString(action.message), MAX_COMMENT_LENGTH) : '';
                if (!comment) return;
                await handleChatEvent(socket, { username, comment, isSuperChat: false, lang: customLang, maxLength: customMaxLength, videoId });
            });

            mc.on('actions', async (actions) => {
                for (const action of actions) {
                    if (action.type === 'addSuperChatItemAction') {
                        const username = sanitizeString(
                            (action.authorName || 'Anonim').replace(/^@/, ''),
                            MAX_USERNAME_LENGTH
                        );
                        const comment = action.message ? sanitizeString(runsToString(action.message), MAX_COMMENT_LENGTH) : '';
                        const amount = action.superchat?.amount
                            ? sanitizeString(`${action.superchat.currency} ${action.superchat.amount}`, 50)
                            : null;
                        await handleChatEvent(socket, { username, comment, isSuperChat: true, amount, lang: customLang, maxLength: customMaxLength, videoId });
                    }
                }
            });

            mc.on('end', (reason) => {
                const safeReason = reason ? sanitizeString(String(reason), 100) : '';
                console.log(`[INFO] Live berakhir: ${safeReason}`);
                socket.emit('sys-message', `⚠️ Live berakhir${safeReason ? ': ' + safeReason : '.'}`);
                stopListening();
            });

            mc.on('error', (err) => {
                const safeMsg = sanitizeString(err.message, 200);
                console.error(`[ERROR] Masterchat:`, safeMsg);
                socket.emit('sys-message', `❌ Error: ${safeMsg}`);
                socket.emit('sys-error', safeMsg);
            });

            mc.listen();

        } catch (err) {
            const safeMsg = sanitizeString(err.message, 200);
            console.error(`[GAGAL] ${safeMsg}`);
            socket.emit('sys-message', `❌ Gagal: ${safeMsg}`);
            socket.emit('sys-error', safeMsg);
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

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
    console.log('[Shutdown] Menutup server...');
    wss.close();
    io.close();
    server.close();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.error('[Unhandled Rejection]', err);
});

server.listen(PORT, () => {
    console.log(`\n✅ Server berjalan di http://localhost:${PORT}`);
    console.log(`   Plain WebSocket tersedia di ws://localhost:${PORT}/ws/chat\n`);
});