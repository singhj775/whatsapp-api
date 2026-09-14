const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let isConnected = false;

// Ensure auth folder exists
if (!fs.existsSync('./auth_info_baileys')) fs.mkdirSync('./auth_info_baileys');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = qr;
            isConnected = false;
        }
        if (connection === 'close') {
            isConnected = false;
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.log('WhatsApp Connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Route to get QR Code for initial login/* Auto-updating QR page */
app.get('/qr', (req, res) => {
    res.send(`
    <html><head><title>WhatsApp QR</title></head>
    <body style="font-family:Arial;text-align:center;padding:40px;background:#0f172a;color:#e2e8f0">
      <h2>📱 WhatsApp Login</h2>
      <div id="box" style="margin-top:20px">Starting WhatsApp engine… (first wake can take ~1 minute)</div>
      <script>
        async function poll(){
          try {
            const r = await fetch('/qr.png?t=' + Date.now());
            const j = await r.json();
            const box = document.getElementById('box');
            if (j.connected) {
              box.innerHTML = '<h2 style="color:#22c55e">✅ Connected! You can close this page.</h2>';
            } else if (j.qr) {
              box.innerHTML = '<img src="' + j.qr + '" style="width:300px;border-radius:16px;background:#fff;padding:12px" /><p>Scan now with WhatsApp → Linked Devices. Page refreshes itself.</p>';
            } else {
              box.innerHTML = 'Starting WhatsApp engine… please wait…';
            }
          } catch(e) {}
        }
        poll();
        setInterval(poll, 4000);
      </script>
    </body></html>`);
});

/* QR image endpoint used by the page above */
app.get('/qr.png', async (req, res) => {
    if (isConnected) return res.json({ connected: true });
    if (!qrCodeData) return res.json({ connected: false, qr: null });
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.json({ connected: false, qr: qrImage });
});

// Route to send message (Called by your PHP Dashboard)
app.post('/send', async (req, res) => {
    const { to, message, token } = req.body;
    
    // Simple security token so strangers can't use your API
    if (token !== 'MY_SECRET_PASSWORD_123') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!isConnected || !sock) return res.status(500).json({ error: 'Not connected. Scan QR first.' });
    
    try {
        // Format number: remove + and spaces, ensure it has country code
        const cleanNumber = to.replace(/[^0-9]/g, ''); 
        await sock.sendMessage(cleanNumber + '@s.whatsapp.net', { text: message });
        res.json({ success: true, message: 'Sent!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* Root status page */
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:Arial;padding:40px">
            <h2>WhatsApp API is running ✅</h2>
            <p>Status: ${isConnected ? '🟢 Connected' : '🔴 Not connected — scan QR'}</p>
            <p><a href="/qr">Open QR login page</a></p>
        </div>
    `);
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    connectToWhatsApp();
    console.log(`API running on port ${PORT}`);
});
