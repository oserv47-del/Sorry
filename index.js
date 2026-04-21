// index.js - Advanced Terminal Server + Telegram Bot + Gemini AI (Neon Hacker Theme)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Adb } = require('@devicefarmer/adbkit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8 
});
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

// ==================== WEB TERMINAL UI (NEON HACKER THEME) ====================
// Standard string concatenation used below to avoid ANY backend parsing errors
const terminalHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Neon Hacker Terminal</title>
    <style>
        :root { --neon: #0f0; --bg: #030303; --panel: #0a0a0a; --dark-green: #003300; }
        * { box-sizing: border-box; }
        body { background: var(--bg); color: var(--neon); font-family: 'Courier New', Courier, monospace; margin: 0; padding: 10px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        h2 { text-align: center; margin: 5px 0 15px; text-shadow: 0 0 8px var(--neon); font-size: 1.3rem; text-transform: uppercase; letter-spacing: 2px; }
        .top-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
        input, select, button { background: var(--panel); color: var(--neon); border: 1px solid #0a0; padding: 12px; border-radius: 4px; font-family: inherit; outline: none; font-size: 14px; }
        input:focus, select:focus { border-color: var(--neon); box-shadow: 0 0 8px var(--dark-green); }
        button { background: var(--dark-green); cursor: pointer; transition: all 0.2s; font-weight: bold; text-transform: uppercase; }
        button:hover { background: var(--neon); color: #000; box-shadow: 0 0 10px var(--neon); }
        .flex-1 { flex: 1; min-width: 140px; }
        
        #terminal { flex-grow: 1; background: var(--panel); border: 1px solid #050; border-radius: 4px; padding: 15px; overflow-y: auto; font-size: 13px; white-space: pre-wrap; box-shadow: inset 0 0 20px #000; margin-bottom: 10px; line-height: 1.4; }
        
        .input-area { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .prompt-wrap { display: flex; flex-grow: 1; align-items: center; background: var(--panel); border: 1px solid #0a0; border-radius: 4px; padding: 0 10px; }
        .prompt { color: var(--neon); font-weight: bold; white-space: nowrap; }
        #cmdInput { border: none; background: transparent; flex-grow: 1; box-shadow: none; padding: 12px 10px; }
        
        .exec-btn { width: auto; min-width: 100px; }
        
        /* Log Colors */
        .log-error { color: #f44336; text-shadow: 0 0 5px #f44336; }
        .log-success { color: #4caf50; }
        .log-cmd { color: #00ffff; text-shadow: 0 0 5px #00ffff; }
        .log-ai { color: #ffeb3b; font-style: italic; }
        
        /* Custom Scrollbar */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: #0a0; border-radius: 3px; }
        
        @media (max-width: 600px) {
            h2 { font-size: 1.1rem; margin-bottom: 10px; }
            .top-bar { flex-direction: column; }
            .flex-1 { width: 100%; }
            .input-area { flex-direction: column; }
            .prompt-wrap { width: 100%; }
            .exec-btn { width: 100%; }
            body { padding: 5px; }
        }
    </style>
</head>
<body>
    <h2>⚡ AI System Terminal ⚡</h2>
    
    <div class="top-bar">
        <input type="password" id="authToken" class="flex-1" placeholder="Auth Token (Auto-saved)" value="">
        <button onclick="loadDevices()">Refresh</button>
        <select id="deviceSelect" class="flex-1">
            <option value="">Select a connected device...</option>
        </select>
    </div>

    <div id="terminal">Boot sequence initiated...
Establishing secure connection to Gemini Core...
Waiting for commands...</div>

    <div class="input-area">
        <div class="prompt-wrap">
            <span class="prompt">root@nexus:~#</span>
            <input type="text" id="cmdInput" placeholder="Command / 'ai <query>' / 'analyze <cmd>'" onkeypress="handleEnter(event)" autocomplete="off">
        </div>
        <button onclick="processInput()" class="exec-btn">Execute</button>
    </div>

    <script>
        const term = document.getElementById('terminal');
        const tokenInput = document.getElementById('authToken');
        
        // --- AUTO LOGIN (LocalStorage) ---
        window.onload = () => {
            const savedToken = localStorage.getItem('hackerTerminalToken');
            if (savedToken) {
                tokenInput.value = savedToken;
                setTimeout(loadDevices, 500); // Auto load if token exists
            }
        };

        function log(msg, type = 'normal') {
            const div = document.createElement('div');
            if (type === 'error') div.className = 'log-error';
            if (type === 'success') div.className = 'log-success';
            if (type === 'cmd') div.className = 'log-cmd';
            if (type === 'ai') div.className = 'log-ai';
            div.textContent = msg;
            term.appendChild(div);
            term.scrollTop = term.scrollHeight;
        }

        async function loadDevices() {
            const token = tokenInput.value;
            if (token) localStorage.setItem('hackerTerminalToken', token); // Save token

            try {
                const res = await fetch('/api/devices', { headers: { 'Authorization': token } });
                const data = await res.json();
                if (!data.success) throw new Error(data.error);
                
                const select = document.getElementById('deviceSelect');
                select.innerHTML = '<option value="">Select a connected device...</option>';
                data.devices.forEach(d => {
                    select.innerHTML += '<option value="' + d.id + '">' + d.model + ' (ID: ' + d.id + ')</option>';
                });
                log('System scanner found ' + data.devices.length + ' active device(s).', 'success');
            } catch (err) {
                log('Access Denied: ' + err.message, 'error');
            }
        }

        async function processInput() {
            const token = tokenInput.value;
            const deviceId = document.getElementById('deviceSelect').value;
            const cmdInput = document.getElementById('cmdInput');
            const input = cmdInput.value.trim();

            if (!input) return;
            if (token) localStorage.setItem('hackerTerminalToken', token); // Save token
            
            cmdInput.value = '';

            // Handle AI Chat
            if (input.startsWith('ai ')) {
                const prompt = input.replace('ai ', '');
                log('> ' + prompt, 'cmd');
                await callAI(prompt, token);
                return;
            }

            if (!deviceId) return log('[!] Error: Target device not selected.', 'error');

            // Handle AI Analyze Command
            if (input.startsWith('analyze ')) {
                const actualCmd = input.replace('analyze ', '');
                log('[Analyze] ' + actualCmd, 'cmd');
                const result = await executeCmd(actualCmd, deviceId, token);
                if(result) {
                    log('[*] Feeding data to Neural Network...', 'ai');
                    await callAI('Analyze this output from command ' + actualCmd + ':\\n' + result, token);
                }
                return;
            }

            // Normal Command
            log('> ' + input, 'cmd');
            await executeCmd(input, deviceId, token);
        }

        async function executeCmd(cmd, deviceId, token) {
            try {
                const res = await fetch('/api/command/' + deviceId, {
                    method: 'POST',
                    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error);
                log(data.result || '[Execution complete. No output returned.]', 'success');
                return data.result;
            } catch (err) {
                log('Command Failed: ' + err.message, 'error');
                return null;
            }
        }

        async function callAI(prompt, token) {
            try {
                const res = await fetch('/api/ai/chat', {
                    method: 'POST',
                    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: prompt })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error);
                log('🤖 Gemini:\\n' + data.response, 'ai');
            } catch (err) {
                log('AI Link Broken: ' + err.message, 'error');
            }
        }

        function handleEnter(e) {
            if (e.key === 'Enter') processInput();
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(terminalHTML));

// ==================== REST API ENDPOINTS ====================

app.get('/api/devices', authMiddleware, async (req, res) => {
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

// AI Processing Route
app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    try {
        if(!process.env.GEMINI_API_KEY) throw new Error("Gemini API Key missing in backend.");
        
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const finalPrompt = "System context: You are an expert hacker, linux admin, and Android terminal assistant. Answer the user briefly and accurately.\\n\\nUser Request: " + prompt;

        const result = await model.generateContent(finalPrompt);
        const text = result.response.text();
        
        await sendTelegramLog("🤖 <b>Gemini AI Log</b>\\n\\n<b>User:</b> " + prompt + "\\n\\n<b>AI:</b> " + text);

        res.json({ success: true, response: text });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Execute Command Route
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command } = req.body;
    
    const device = connectedDevices.get(deviceId);
    if (!device) {
        return res.status(404).json({ success: false, error: 'Device disconnected' });
    }

    const requestId = Date.now() + '-' + Math.random().toString(36);
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('Device timed out'));
        }, 30000);
        pendingCommands.set(requestId, { resolve, reject, timer, command, deviceId }); 
    });

    try {
        device.socket.emit('execute_command', { requestId, command });
        const result = await commandPromise;
        res.json({ success: true, requestId, result });
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
        
        await sendTelegramLog("📱 <b>New Device Connected!</b>\\nID: " + deviceId + "\\nModel: " + socket.deviceInfo.model);
        socket.emit('registered', { success: true });
    });

    socket.on('command_response', async (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);
        
        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);
            
            let tgMsg = success 
                ? "✅ <b>Command Success</b>\\n\\n<b>Device:</b> " + pending.deviceId + "\\n<b>Cmd:</b> " + pending.command + "\\n\\n<b>Output:</b>\\n" + result
                : "❌ <b>Command Failed</b>\\n\\n<b>Device:</b> " + pending.deviceId + "\\n<b>Cmd:</b> " + pending.command + "\\n\\n<b>Error:</b>\\n" + error;
            
            await sendTelegramLog(tgMsg);

            if (success) pending.resolve(result);
            else pending.reject(new Error(error || 'Failed on device'));
        }
    });

    socket.on('disconnect', async () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            await sendTelegramLog("⚠️ <b>Device Disconnected</b>\\nID: " + socket.deviceId);
        }
    });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log("🚀 Neon Server Running on Port " + PORT);
});
