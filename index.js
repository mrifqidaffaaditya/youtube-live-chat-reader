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
const DEBUG_MODE = process.env.DEBUG ? process.env.DEBUG.toLowerCase() : '';

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

// Map sesi: streamKey → Set<ws>
// Key '*' digunakan untuk client yang ingin menerima SEMUA stream
const wsSessionMap = new Map();

// ─── Auto-Connect: Shared Live Sessions ───────────────────────────────────────
// Map: streamKey → { mc: Masterchat, status: string }
const liveSessionMap = new Map();

// FIX: Rate limiting koneksi WS per IP — cegah flood
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

const ioSessionMap = new Map();

function addIoClient(socket, streamKey, lang = TTS_LANG, maxLength = TTS_MAX_LENGTH) {
    if (!ioSessionMap.has(streamKey)) ioSessionMap.set(streamKey, new Map());
    ioSessionMap.get(streamKey).set(socket, { lang, maxLength });
}

function removeIoClient(socket, streamKey) {
    const clients = ioSessionMap.get(streamKey);
    if (clients) {
        clients.delete(socket);
        if (clients.size === 0) ioSessionMap.delete(streamKey);
    }
}

// ─── Logger Helpers ───────────────────────────────────────────────────────────
function getWsClientCount(streamKey) {
    const allWs = wsSessionMap.get('*') ? wsSessionMap.get('*').size : 0;
    const specificWs = wsSessionMap.get(streamKey) ? wsSessionMap.get(streamKey).size : 0;
    const ioClients = ioSessionMap.get(streamKey) ? ioSessionMap.get(streamKey).size : 0;
    return allWs + specificWs + ioClients;
}

function getTotalWsClientCount() {
    let total = 0;
    for (const clients of wsSessionMap.values()) total += clients.size;
    for (const clients of ioSessionMap.values()) total += clients.size;
    return total;
}

function logWsConnection(action, ip, streamKey) {
    const time = new Date().toISOString();
    if (DEBUG_MODE === 'all' || DEBUG_MODE === 'connection') {
        const streamCount = getWsClientCount(streamKey);
        const totalCount = getTotalWsClientCount();
        console.log(`[${time}] [DEBUG-CONN] ${action} | IP: ${ip} | Stream: ${streamKey} | Stream Clients: ${streamCount} | Total Clients: ${totalCount}`);
    } else {
        if (action === 'CONNECTED') console.log(`[${time}] [WS] Client terhubung: ${ip} (stream: ${streamKey})`);
        else if (action === 'DISCONNECTED') console.log(`[${time}] [WS] Client terputus: ${ip} (stream: ${streamKey})`);
    }
}

function logIoConnection(action, socketId, targetVideoId = null) {
    const time = new Date().toISOString();
    if (DEBUG_MODE === 'all' || DEBUG_MODE === 'connection') {
        const totalCount = io.engine.clientsCount;
        const streamInfo = targetVideoId ? ` | VideoID: ${targetVideoId}` : '';
        console.log(`[${time}] [DEBUG-CONN] Socket.IO ${action} | ID: ${socketId}${streamInfo} | Total IO Clients: ${totalCount}`);
    } else {
        if (action === 'CONNECTED') console.log(`[${time}] [INFO] Client terhubung: ${socketId}`);
        else if (action === 'DISCONNECTED') console.log(`[${time}] [INFO] Client terputus: ${socketId}`);
    }
}

function logChatInfo(platform, streamKey, username, comment, isSuperChat = false, amount = null) {
    if (DEBUG_MODE === 'all') {
        const streamCount = getWsClientCount(streamKey);
        const superChatInfo = isSuperChat ? `[SUPERCHAT ${amount}] ` : '';
        console.log(`[DEBUG-CHAT] [${platform.toUpperCase()} - ${streamKey}] | WS Clients: ${streamCount} | ${superChatInfo}${username}: ${comment}`);
    } else if (DEBUG_MODE === 'connection') {
        // Mute chat logs in connection mode
        return;
    } else {
        const superChatInfo = isSuperChat ? `💛 SUPERCHAT ` : '';
        console.log(`[CHAT] ${superChatInfo}${username}: ${comment}`);
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

/**
 * Mulai koneksi YouTube Live untuk videoId tertentu (shared/reference-counted).
 */
async function startLiveSession(streamKey) {
    if (liveSessionMap.has(streamKey)) {
        console.log(`[WS-Auto] Reuse session untuk ${streamKey}`);
        return;
    }

    // Parse videoId dari streamKey
    const videoId = parseVideoId(streamKey);
    if (!videoId) {
        console.warn(`[WS-Auto] Stream key tidak valid sebagai videoId: ${streamKey}`);
        broadcastToWsClients({ type: 'status', message: `❌ Video ID tidak valid: ${streamKey}` }, streamKey);
        return;
    }

    console.log(`[WS-Auto] Memulai koneksi YouTube Live untuk ${videoId}...`);

    const session = { mc: null, status: 'connecting' };
    liveSessionMap.set(streamKey, session);

    // Broadcast status ke semua WS & IO subscriber
    const notifySubscribers = (msg) => {
        broadcastToWsClients({ type: 'status', message: msg, stream: streamKey }, streamKey);
        const ioClients = ioSessionMap.get(streamKey);
        if (ioClients) {
            for (const socket of ioClients.keys()) {
                socket.emit('sys-message', msg);
            }
        }
    };

    notifySubscribers(`⏳ Menghubungkan ke live stream ${videoId}...`);

    try {
        const mc = new Masterchat(videoId, '', { mode: 'live' });
        session.mc = mc;

        await mc.populateMetadata();
        const title = sanitizeString(mc.title || videoId, 200);
        console.log(`[WS-Auto] ✅ Terhubung ke: "${title}" (${videoId})`);
        session.status = 'connected';
        notifySubscribers(`✅ Terhubung! Memantau: ${title}`);

        mc.on('chat', async (action) => {
            if (!liveSessionMap.has(streamKey)) return;
            if (action.type !== 'addChatItemAction') return;

            const username = sanitizeString(
                (action.authorName || 'Anonim').replace(/^@/, ''),
                MAX_USERNAME_LENGTH
            );
            const comment = action.message ? sanitizeString(runsToString(action.message), MAX_COMMENT_LENGTH) : '';
            if (!comment) return;

            logChatInfo('youtube', streamKey, username, comment);

            let audioBase64 = null;
            let audioUrl = null;
            const textToSpeak = `${username} berkata, ${comment}`.substring(0, TTS_MAX_LENGTH);

            try {
                audioBase64 = await googleTTS.getAudioBase64(textToSpeak, {
                    lang: TTS_LANG, slow: false, host: 'https://translate.google.com', timeout: 10000
                });
                if (audioBase64) {
                    const audioId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
                    audioCache.set(audioId, Buffer.from(audioBase64, 'base64'));
                    setTimeout(() => { audioCache.delete(audioId); }, CACHE_TIMEOUT);
                    audioUrl = `/audio/${audioId}.mp3`;
                }
            } catch (ttsErr) {
                console.error('[TTS Error]', sanitizeString(ttsErr.message, 200));
            }

            const chatPayload = {
                type: 'chat',
                platform: 'youtube',
                stream: streamKey,
                username,
                comment,
                isSuperChat: false,
                amount: null,
                audioUrl,
            };

            broadcastToWsClients(chatPayload, streamKey);

            const ioClients = ioSessionMap.get(streamKey);
            if (ioClients) {
                for (const [socket, prefs] of ioClients.entries()) {
                    let finalAudioBase64 = audioBase64;
                    let finalAudioUrl = audioUrl;

                    if (prefs.lang !== TTS_LANG || prefs.maxLength !== TTS_MAX_LENGTH) {
                        try {
                            const customTextToSpeak = textToSpeak.substring(0, prefs.maxLength);
                            finalAudioBase64 = await googleTTS.getAudioBase64(
                                customTextToSpeak,
                                { lang: prefs.lang, slow: false, host: 'https://translate.google.com', timeout: 10000 }
                            );
                            if (finalAudioBase64) {
                                const audioId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
                                audioCache.set(audioId, Buffer.from(finalAudioBase64, 'base64'));
                                setTimeout(() => { audioCache.delete(audioId); }, CACHE_TIMEOUT);
                                finalAudioUrl = `/audio/${audioId}.mp3`;
                            }
                        } catch (e) {
                            console.error('[TTS Error Custom]', sanitizeString(e.message, 200));
                        }
                    }

                    const ioPayload = {
                        username,
                        comment,
                        isSuperChat: false,
                        amount: null,
                        audioData: finalAudioBase64 ? `data:audio/mp3;base64,${finalAudioBase64}` : null,
                        audioUrl: finalAudioUrl,
                    };
                    socket.emit('chat', ioPayload);
                }
            }
        });

        mc.on('actions', async (actions) => {
            if (!liveSessionMap.has(streamKey)) return;
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

                    logChatInfo('youtube', streamKey, username, comment, true, amount);

                    let audioBase64 = null;
                    let audioUrl = null;
                    let textToSpeak;
                    if (amount) {
                        textToSpeak = `Super Chat dari ${username}, ${amount}${comment ? `, berkata, ${comment}` : ''}`;
                    } else {
                        textToSpeak = `${username} berkata, ${comment}`;
                    }

                    try {
                        audioBase64 = await googleTTS.getAudioBase64(
                            textToSpeak.substring(0, TTS_MAX_LENGTH),
                            { lang: TTS_LANG, slow: false, host: 'https://translate.google.com', timeout: 10000 }
                        );
                        if (audioBase64) {
                            const audioId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
                            audioCache.set(audioId, Buffer.from(audioBase64, 'base64'));
                            setTimeout(() => { audioCache.delete(audioId); }, CACHE_TIMEOUT);
                            audioUrl = `/audio/${audioId}.mp3`;
                        }
                    } catch (ttsErr) {
                        console.error('[TTS Error]', sanitizeString(ttsErr.message, 200));
                    }

                    const chatPayload = {
                        type: 'chat',
                        platform: 'youtube',
                        stream: streamKey,
                        username,
                        comment,
                        isSuperChat: true,
                        amount,
                        audioUrl,
                    };

                    broadcastToWsClients(chatPayload, streamKey);

                    const ioClients = ioSessionMap.get(streamKey);
                    if (ioClients) {
                        for (const [socket, prefs] of ioClients.entries()) {
                            let finalAudioBase64 = audioBase64;
                            let finalAudioUrl = audioUrl;

                            if (prefs.lang !== TTS_LANG || prefs.maxLength !== TTS_MAX_LENGTH) {
                                try {
                                    const customTextToSpeak = textToSpeak.substring(0, prefs.maxLength);
                                    finalAudioBase64 = await googleTTS.getAudioBase64(
                                        customTextToSpeak,
                                        { lang: prefs.lang, slow: false, host: 'https://translate.google.com', timeout: 10000 }
                                    );
                                    if (finalAudioBase64) {
                                        const audioId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
                                        audioCache.set(audioId, Buffer.from(finalAudioBase64, 'base64'));
                                        setTimeout(() => { audioCache.delete(audioId); }, CACHE_TIMEOUT);
                                        finalAudioUrl = `/audio/${audioId}.mp3`;
                                    }
                                } catch (e) {
                                    console.error('[TTS Error Custom]', sanitizeString(e.message, 200));
                                }
                            }

                            const ioPayload = {
                                username,
                                comment,
                                isSuperChat: true,
                                amount,
                                audioData: finalAudioBase64 ? `data:audio/mp3;base64,${finalAudioBase64}` : null,
                                audioUrl: finalAudioUrl,
                            };
                            socket.emit('chat', ioPayload);
                        }
                    }
                }
            }
        });

        mc.on('end', (reason) => {
            const safeReason = reason ? sanitizeString(String(reason), 100) : '';
            console.log(`[WS-Auto] Live berakhir: ${safeReason}`);
            notifySubscribers(`⚠️ Live berakhir${safeReason ? ': ' + safeReason : '.'}`);
            // Cleanup
            try { mc.removeAllListeners(); mc.stop(); } catch (e) {}
            liveSessionMap.delete(streamKey);
        });

        mc.on('error', (err) => {
            const safeMsg = sanitizeString(err.message, 200);
            console.error(`[WS-Auto] Masterchat Error:`, safeMsg);
            notifySubscribers(`❌ Error: ${safeMsg}`);
            
            const ioClients = ioSessionMap.get(streamKey);
            if (ioClients) {
                for (const socket of ioClients.keys()) {
                    socket.emit('sys-error', safeMsg);
                }
            }
            try { mc.removeAllListeners(); mc.stop(); } catch (e) {}
            liveSessionMap.delete(streamKey);
        });

        mc.listen();

    } catch (err) {
        const safeMsg = sanitizeString(err.message, 200);
        console.error(`[WS-Auto] ❌ Gagal connect ke ${streamKey}:`, safeMsg);
        notifySubscribers(`❌ Gagal: ${safeMsg}`);
        
        const ioClients = ioSessionMap.get(streamKey);
        if (ioClients) {
            for (const socket of ioClients.keys()) {
                socket.emit('sys-error', safeMsg);
            }
        }
        liveSessionMap.delete(streamKey);
    }
}

/**
 * Hentikan koneksi YouTube Live jika tidak ada client lagi.
 */
function stopLiveSessionIfEmpty(streamKey) {
    const session = liveSessionMap.get(streamKey);
    if (!session) return;

    // Hitung jumlah client aktif secara dinamis (WS specific + IO specific)
    const specificWsCount = wsSessionMap.get(streamKey) ? wsSessionMap.get(streamKey).size : 0;
    const specificIoCount = ioSessionMap.get(streamKey) ? ioSessionMap.get(streamKey).size : 0;
    const activeSubscribers = specificWsCount + specificIoCount;

    console.log(`[WS-Auto] Active subscribers for ${streamKey}: ${activeSubscribers}`);

    if (activeSubscribers <= 0) {
        console.log(`[WS-Auto] Semua client disconnect, menghentikan ${streamKey}`);
        if (session.mc) {
            try { session.mc.removeAllListeners(); session.mc.stop(); } catch (e) {}
        }
        liveSessionMap.delete(streamKey);
    }
}

wss.on('connection', (ws) => {
    const streamKey = ws._streamKey;
    const ip = ws._ip || 'unknown';
    addWsClient(ws, streamKey);
    logWsConnection('CONNECTED', ip, streamKey);

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

    // ─── Auto-Connect: Langsung mulai koneksi YouTube Live ────────────────────
    if (streamKey !== '*') {
        startLiveSession(streamKey);
    }

    // ─── Handle pesan dari WS client ──────────────────────────────────────────
    ws.on('message', (rawMsg) => {
        try {
            const msg = JSON.parse(rawMsg.toString());
            if (msg.action === 'stop' && streamKey !== '*') {
                console.log(`[WS] Client ${ip} mengirim stop untuk ${streamKey}`);
                stopLiveSessionIfEmpty(streamKey);
            }
        } catch (e) {
            // Abaikan pesan non-JSON
        }
    });

    ws.on('close', () => {
        removeWsClient(ws, streamKey);
        logWsConnection('DISCONNECTED', ip, streamKey);
        const count = wsIpCount.get(ip) || 1;
        if (count <= 1) wsIpCount.delete(ip);
        else wsIpCount.set(ip, count - 1);

        // Auto-cleanup: hentikan live jika tidak ada subscriber lagi
        if (streamKey !== '*') {
            stopLiveSessionIfEmpty(streamKey);
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error client ${ip}:`, err.message);
        removeWsClient(ws, streamKey);
        const count = wsIpCount.get(ip) || 1;
        if (count <= 1) wsIpCount.delete(ip);
        else wsIpCount.set(ip, count - 1);

        // Auto-cleanup
        if (streamKey !== '*') {
            stopLiveSessionIfEmpty(streamKey);
        }
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

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    logIoConnection('CONNECTED', socket.id);

    let currentStreamKey = null;

    socket.on('set-video', async (input) => {
        if (!input || (typeof input !== 'string' && (typeof input !== 'object' || Array.isArray(input)))) {
            socket.emit('sys-message', '❌ Input tidak valid.');
            return;
        }

        let videoIdRaw = input;
        let customLang = TTS_LANG;
        let customMaxLength = TTS_MAX_LENGTH;

        if (typeof input === 'object' && input !== null) {
            videoIdRaw = input.videoId || input.url;
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
        
        if (currentStreamKey) {
            removeIoClient(socket, currentStreamKey);
            stopLiveSessionIfEmpty(currentStreamKey);
        }

        currentStreamKey = videoId;
        addIoClient(socket, currentStreamKey, customLang, customMaxLength);
        
        const isNewSession = !liveSessionMap.has(currentStreamKey);
        startLiveSession(currentStreamKey);
        
        if (!isNewSession) {
            const session = liveSessionMap.get(currentStreamKey);
            if (session && session.status === 'connected') {
                socket.emit('sys-message', `✅ Terhubung! Memantau: ${currentStreamKey}`);
            } else if (session && session.status === 'connecting') {
                socket.emit('sys-message', `⏳ Menghubungkan ke live stream...`);
            }
        }
    });

    socket.on('stop', () => {
        if (currentStreamKey) {
            removeIoClient(socket, currentStreamKey);
            stopLiveSessionIfEmpty(currentStreamKey);
            currentStreamKey = null;
        }
        socket.emit('sys-message', '⏹️ Pemantauan dihentikan.');
    });

    socket.on('disconnect', () => {
        logIoConnection('DISCONNECTED', socket.id, currentStreamKey);
        if (currentStreamKey) {
            removeIoClient(socket, currentStreamKey);
            stopLiveSessionIfEmpty(currentStreamKey);
            currentStreamKey = null;
        }
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