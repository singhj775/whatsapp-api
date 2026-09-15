const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.SECRET || 'MY_SECRET_PASSWORD_123';

const RECEIPTS_URL   = process.env.RECEIPTS_URL   || 'https://v.srsmartsolutions.in/receipts.php';
const RECEIPTS_TOKEN = process.env.RECEIPTS_TOKEN || 'SR-RECEIPTS-2026';

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connecting = false;

/* ---------- debug log ring ---------- */
const LOGS = [];
function log(msg) {
    const line = new Date().toISOString() + ' | ' + msg;
    LOGS.push(line);
    if (LOGS.length > 60) LOGS.shift();
    console.log(line);
}
process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION: ' + (e && e.stack ? e.stack : e)));
process.on('uncaughtException',  (e) => log('UNCAUGHT EXCEPTION: '  + (e && e.stack ? e.stack : e)));

/* ---------- Baileys loader: survives rename + ESM ---------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers;

async function loadBaileys() {
    if (makeWASocket) return;
    let mod = null, err1 = null, err2 = null;
    try { mod = await import('baileys'); }
    catch (e) {
        err1 = e;
        try { mod = await import('@whiskeysockets/baileys'); }
        catch (e2) { err2 = e2; }
    }
    if (!mod) {
        log('BAILEYS IMPORT FAILED: ' + (err1 ? err1.message : '') + ' || ' + (err2 ? err2.message : ''));
        throw (err2 || err1);
    }
    const M = (mod && mod.makeWASocket) ? mod : (mod && mod.default ? mod.default : mod);
    makeWASocket = M.makeWASocket;
    useMultiFileAuthState = M.useMultiFileAuthState;
    DisconnectReason = M.DisconnectReason;
    Browsers = M.Browsers;
    log('baileys loaded OK');
}

function baileysVersion() {
    const candidates = [
        './node_modules/baileys/package.json',
        './node_modules/@whiskeysockets/baileys/package.json'
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).version;
        } catch (e) {}
    }
    return 'unknown';
}

/* ---------- auth folder ---------- */
const AUTH_DIR = './auth_info_baileys';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

function wipeAuth() {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.mkdirSync(AUTH_DIR); } catch (e) {}
}

/* ---------- WhatsApp connection ---------- */
async function connectToWhatsApp() {
    if (connecting || isConnected) return;
    connecting = true;
    try {
        await loadBaileys();
        log('connectToWhatsApp() start');
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: (Browsers && Browsers.macOS) ? Browsers.macOS('Chrome') : ['Chrome', '127.0.0.0'],
            syncFullHistory: false,
            getMessage: async () => ({}),
            logger: require('pino')({ level: 'error' })
        });
        log('socket created');

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { qrCodeData = qr; isConnected = false; log('QR generated — waiting for scan'); }
            if (connection) log('connection state: ' + connection);
            if (connection === 'close') {
                isConnected = false;
                const reason = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.output.statusCode : 'unknown';
                log('closed reason=' + reason);
                if (reason === DisconnectReason.badSession || reason === 405) {
                    log('bad session detected — wiping auth folder for a fresh QR');
                    wipeAuth();
                }
                if (reason !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 4000);
                else log('LOGGED OUT — rescan needed');
            } else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                log('WhatsApp Connected!');
            }
        });
            sock.ev.on('messages.update', (updates) => {
            const MAP = { 3: 'delivered', 4: 'read', 5: 'read', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read' };
            const events = [];
            for (const u of updates || []) {
                const id = u && u.key && u.key.id;
                const st = u && u.update && u.update.status;
                if (!id || st === undefined || st === null) continue;
                const status = MAP[st] || (typeof st === 'string' ? (MAP[st.toUpperCase()] || null) : null);
                if (status) events.push({ message_id: id, status });
            }
            if (!events.length) return;
            fetch(RECEIPTS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: RECEIPTS_TOKEN, events })
            }).catch(e => log('receipts push failed: ' + e.message));
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        log('connect ERROR: ' + (err && err.stack ? err.stack : err));
        setTimeout(connectToWhatsApp, 8000);
    } finally {
        connecting = false;
    }
}

/* ---------- routes ---------- */
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:Arial;padding:40px">
            <h2>WhatsApp API is running ✅</h2>
            <p>Status: ${isConnected ? '🟢 Connected' : '🔴 Not connected — scan QR'}</p>
            <p><a href="/qr">Open QR login page</a></p>
        </div>`);
});

app.get('/status', (req, res) => res.json({ connected: isConnected }));

function debugHandler(token, res) {
    if (token !== SECRET) return res.status(401).send('nope');
    res.json({ connected: isConnected, hasQr: !!qrCodeData, logs: LOGS });
}
app.get('/debug', (req, res) => debugHandler(req.query.token, res));
app.get('/debug/:token', (req, res) => debugHandler(req.params.token, res));

app.get('/qr', (req, res) => {
    res.send(`
    <html><head><title>WhatsApp QR</title></head>
    <body style="font-family:Arial;text-align:center;padding:40px;background:#0f172a;color:#e2e8f0">
      <h2>📱 WhatsApp Login</h2>
      <div id="box" style="margin-top:20px">Starting WhatsApp engine…</div>
      <script>
        async function poll(){
          try {
            const r = await fetch('/qr.png?t=' + Date.now());
            const j = await r.json();
            const box = document.getElementById('box');
            if (j.connected) box.innerHTML = '<h2 style="color:#22c55e">✅ Connected! You can close this page.</h2>';
            else if (j.qr)   box.innerHTML = '<img src="' + j.qr + '" style="width:300px;border-radius:16px;background:#fff;padding:12px" /><p>Scan now — auto-refreshes</p>';
            else box.innerHTML = 'Starting WhatsApp engine… please wait…';
          } catch(e) {}
        }
        poll(); setInterval(poll, 4000);
      </script>
    </body></html>`);
});

app.get('/qr.png', async (req, res) => {
    if (isConnected) return res.json({ connected: true });
    if (!qrCodeData) return res.json({ connected: false, qr: null });
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.json({ connected: false, qr: qrImage });
});

app.post('/send', async (req, res) => {
    const { to, message, token } = req.body;
    if (token !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!isConnected || !sock) return res.status(500).json({ error: 'Not connected. Scan QR first.' });
    try {
        const clean = String(to).replace(/[^0-9]/g, '');
        const sent = await sock.sendMessage(clean + '@s.whatsapp.net', { text: message });
        res.json({ success: true, message_id: (sent && sent.key && sent.key.id) ? sent.key.id : null });
    } catch (err) {
        log('send ERROR: ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log('baileys version: ' + baileysVersion());
    log('API running on port ' + PORT);
    connectToWhatsApp();
});
