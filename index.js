// index.js - Advanced Terminal Server + Telegram Bot + Gemini AI (FIXED)
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
    
    if (!token || !chatId) {
        console.log("Telegram Token or Chat ID missing. Log skipped.");
        return;
    }

    try {
        // Telegram message limit is 4096. Truncate if data is too big.
        let text = message.length > 4000 ? message.substring(0, 3990) + "\n...[TRUNCATED]" : message;
        
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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

// ==================== WEB TERMINAL UI (HOME PAGE) ====================
// Note: Backslashes here are intentional to escape variables inside the HTML string
const terminalHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Powered Remote Terminal</title>
    <style>
        body { background: #0d1117; color: #00ff00; font-family: 'Courier New', Courier, monospace; padding: 20px; margin: 0; }
        h2 { color: #58a6ff; margin-top: 0; border-bottom: 1px solid #30363d; padding-bottom: 10px; }
        .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 15px; }
        input, select, button { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; padding: 10px; border-radius: 5px; font-family: inherit; }
        button { cursor: pointer; background: #238636; color: white; font-weight: bold; }
        button:hover { background: #2ea043; }
        #terminal { background: #000; border: 1px solid #30363d; height: 60vh; overflow-y: auto; padding: 15px; border-radius: 5px; white-space: pre-wrap; font-size: 14px; box-shadow: inset 0 0 10px #000; }
        .input-group { display: flex; gap: 10px; margin-top: 15px; align-items: center; }
        #cmdInput { flex-grow: 1; padding: 12px; background: #000; color: #00ff00; font-size: 16px; border: 1px solid #30363d; }
        .prompt { color: #58a6ff; font-weight: bold; font-size: 18px; }
        .log-error { color: #ff7b72; }
        .log-success { color: #3fb950; }
        .log-cmd { color: #d2a8ff; font-weight: bold; }
        .log-ai { color: #f2cc60; font-style: italic; }
        .helper-text { color: #8b949e; font-size: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <h2>🤖 AI Powered Remote Android Terminal</h2>
    
    <div class="controls">
        <input type="password" id="authToken" placeholder="Enter Auth Token" value="">
        <button onclick="loadDevices()">🔄 Refresh Devices</button>
        <select id="deviceSelect">
            <option value="">Select a connected device...</option>
        </select>
    </div>

    <div id="terminal">System Initialized. Connected to Gemini AI. Awaiting commands...</div>

    <div class="input-group">
        <span class="prompt">root@server:~#</span>
        <input type="text" id="cmdInput" placeholder="Normal command OR 'ai <question>' OR 'analyze <command>'" onkeypress="handleEnter(event)">
        <button onclick="processInput()" style="padding: 12px 20px;">Execute</button>
    </div>
    
    <div class="helper-text">
        <b>Pro Tips:</b><br>
        1. Type normal commands (e.g., <code>ls -l /sdcard</code>)<br>
        2. Type <code>ai write a bash script to ping google</code> to ask Gemini directly.<br>
        3. Type <code>analyze dumpsys battery</code> to run the command on device AND send output to Gemini for analysis.
    </div>

    <script>
        const term = document.getElementById('terminal');
        
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
            const token = document.getElementById('authToken').value;
            try {
                const res = await fetch('/api/devices', { headers: { 'Authorization': token } });
                const data = await res.json();
                if (!data.success) throw new Error(data.error);
                
                const select = document.getElementById('deviceSelect');
                select.innerHTML = '<option value="">Select a connected device...</option>';
                data.devices.forEach(d => {
                    select.innerHTML += \`<option value="\${d.id}">\${d.model} (ID: \${d.id})\</option>\`;
                });
                log(\`Found \${data.devices.length} connected device(s).\`, 'success');
            } catch (err) {
                log(\`Fetch Error: \${err.message}\`, 'error');
            }
        }

        async function processInput() {
            const token = document.getElementById('authToken').value;
            const deviceId = document.getElementById('deviceSelect').value;
            const cmdInput = document.getElementById('cmdInput');
            const input = cmdInput.value.trim();

            if (!input) return;
            cmdInput.value = '';

            // Handle AI Chat
            if (input.startsWith('ai ')) {
                const prompt = input.replace('ai ', '');
                log(\`[AI Query] \${prompt}\`, 'cmd');
                await callAI(prompt, token);
                return;
            }

            if (!deviceId) return log('❌ Please select a device to run commands.', 'error');

            // Handle AI Analyze Command
            if (input.startsWith('analyze ')) {
                const actualCmd = input.replace('analyze ', '');
                log(\`[Analyzing Command] \${actualCmd}\`, 'cmd');
                const result = await executeCmd(actualCmd, deviceId, token);
                if(result) {
                    log(\`[AI Analyzing Output...]\`, 'ai');
                    await callAI(\`Analyze this output from command '\${actualCmd}':\`, token, result);
                }
                return;
            }

            // Normal Command
            log(\`> \${input}\`, 'cmd');
            await executeCmd(input, deviceId, token);
        }

        async function executeCmd(cmd, deviceId, token) {
            try {
                const res = await fetch(\`/api/command/\${deviceId}\`, {
                    method: 'POST',
                    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error);
                log(data.result || 'Executed successfully with no output.', 'success');
                return data.result;
            } catch (err) {
                log(\`Execution Error: \${err.message}\`, 'error');
                return null;
            }
        }

        async function callAI(prompt, token, contextData = null) {
            try {
                const res = await fetch('/api/ai/chat', {
                    method: 'POST',
                    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt, contextData })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error);
                log(\`🤖 Gemini: \n\${data.response}\`, 'ai');
            } catch (err) {
                log(\`AI Error: \${err.message}\`, 'error');
            }
        }

        function handleEnter(e) {
            if (e.key === 'Enter') processInput();
        }
        
        window.onload = loadDevices;
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

// AI Processing Route (Gemini Free Model)
app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    const { prompt, contextData } = req.body;
    try {
        if(!process.env.GEMINI_API_KEY) throw new Error("Gemini API Key is not set in Server Env.");
        
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        
        // NO EXTRA BACKSLASHES HERE NOW (Fixed Error)
        let finalPrompt = contextData 
            ? `System context: You are an expert remote device manager. Analyze the following terminal output for the user.\n\nUser Request: ${prompt}\n\nTerminal Output Data:\n${contextData}`
            : `System context: You are a helpful Linux and Android terminal assistant. Answer the user briefly.\n\nUser Question: ${prompt}`;

        const result = await model.generateContent(finalPrompt);
        const text = result.response.text();
        
        // Send AI log to Telegram
        await sendTelegramLog(`🤖 <b>Gemini AI Interaction</b>\n\n<b>User:</b> ${prompt}\n\n<b>AI:</b> ${text}`);

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

    const requestId = `${Date.now()}-${Math.random().toString(36)}`;
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
        socket.join(`device:${deviceId}`);
        
        // NO EXTRA BACKSLASHES HERE (Fixed Error)
        await sendTelegramLog(`📱 <b>New Device Connected!</b>\nID: ${deviceId}\nModel: ${socket.deviceInfo.model}`);
        socket.emit('registered', { success: true });
    });

    socket.on('command_response', async (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);
        
        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);
            
            // NO EXTRA BACKSLASHES HERE (Fixed Error)
            let tgMsg = success 
                ? `✅ <b>Command Execution Success</b>\n\n<b>Device:</b> ${pending.deviceId}\n<b>Command:</b> ${pending.command}\n\n<b>Output:</b>\n${result}`
                : `❌ <b>Command Execution Failed</b>\n\n<b>Device:</b> ${pending.deviceId}\n<b>Command:</b> ${pending.command}\n\n<b>Error:</b>\n${error}`;
            
            await sendTelegramLog(tgMsg);

            if (success) pending.resolve(result);
            else pending.reject(new Error(error || 'Failed on device'));
        }
    });

    socket.on('disconnect', async () => {
        if (socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            await sendTelegramLog(`⚠️ <b>Device Disconnected</b>\nID: ${socket.deviceId}`);
        }
    });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server Running on Port ${PORT}`);
});
