const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.SECRET || 'MY_SECRET_PASSWORD_123';

let sock = null;
let qrCodeData = null;
let isConnected = false;

/* ---------- in-memory debug log (open /debug?token=...) ---------- */
const LOGS = [];
function log(msg) {
    const line = new Date().toISOString() + ' | ' + msg;
    LOGS.push(line);
    if (LOGS.length > 60) LOGS.shift();
    console.log(line);
}
process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION: ' + (e && e.stack ? e.stack : e)));
process.on('uncaughtException',  (e) => log('UNCAUGHT EXCEPTION: '  + (e && e.stack ? e.stack : e)));

if (!fs.existsSync('./auth_info_baileys')) fs.mkdirSync('./auth_info_baileys');

/* ---------- WhatsApp connection ---------- */
async function connectToWhatsApp() {
    try {
        log('connectToWhatsApp() start');
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp API', 'Chrome', '120.0.0.0'],
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
                    try { fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); } catch (e) {}
                    try { fs.mkdirSync('./auth_info_baileys'); } catch (e) {}
                }
                if (reason !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 4000);
                else log('LOGGED OUT — rescan needed');
            } else if (connection === 'open') {
                isConnected = true; qrCodeData = null;
                log('WhatsApp Connected!');
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        log('connect ERROR: ' + (err && err.stack ? err.stack : err));
        setTimeout(connectToWhatsApp, 8000);
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

app.get('/debug', (req, res) => {
    if (req.query.token !== SECRET) return res.status(401).send('nope');
    res.json({ connected: isConnected, hasQr: !!qrCodeData, logs: LOGS });
});

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
        await sock.sendMessage(clean + '@s.whatsapp.net', { text: message });
        res.json({ success: true });
    } catch (err) {
        log('send ERROR: ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    try { 
        log('baileys version: ' + require('@whiskeysockets/baileys/package.json').version); 
    } catch (e) {
        log('could not read baileys version: ' + e.message);
    }

    log('API running on port ' + PORT);
    connectToWhatsApp();
});
