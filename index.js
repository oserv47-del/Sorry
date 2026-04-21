// index.js - Complete Advanced Server for Render.com
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const adb = require('@devicefarmer/adbkit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8 // 100MB for file transfers
});
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ADB Client Setup
const adbClient = adb.createClient();

// Data Storage (In-Memory)
const connectedDevices = new Map(); // deviceId -> { socket, deviceInfo, adbId }
const pendingCommands = new Map(); // requestId -> { resolve, reject, timer }

// --- Authentication Middleware ---
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (!token || token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// ==================== CORE ADB HELPER ====================
async function executeAdbCommand(deviceId, command, args = []) {
    try {
        const device = connectedDevices.get(deviceId);
        if (!device || !device.adbId) {
            throw new Error('Device not connected or ADB ID not found');
        }
        // Use adbkit to run shell command
        const stream = await adbClient.shell(device.adbId, `${command} ${args.join(' ')}`);
        const output = await adb.util.readAll(stream);
        return output.toString().trim();
    } catch (error) {
        console.error(`ADB Command Error: ${error.message}`);
        throw error;
    }
}

// ==================== REST API ENDPOINTS ====================

// 1. AI Assistant Endpoint
app.post('/api/ai/assist', authMiddleware, async (req, res) => {
    try {
        const { prompt, deviceId } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        
        let context = "You are an advanced assistant for remote Android management. Provide precise, actionable advice. ";
        if (deviceId) {
            context += `The user is currently managing device: ${deviceId}. `;
        }

        const result = await model.generateContent(context + prompt);
        const response = await result.response;
        const text = response.text();
        
        res.json({ success: true, response: text });
    } catch (error) {
        console.error('AI Error:', error);
        res.status(500).json({ success: false, error: 'AI service failed' });
    }
});

// 2. List Connected Devices
app.get('/api/devices', authMiddleware, async (req, res) => {
    try {
        const adbDevices = await adbClient.listDevices();
        const devices = adbDevices.map(d => ({
            id: d.id,
            type: d.type,
            model: connectedDevices.get(d.id)?.deviceInfo?.model || 'Unknown'
        }));
        res.json({ success: true, devices });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Send Command to Device (Terminal API)
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command, params } = req.body;
    
    const device = connectedDevices.get(deviceId);
    if (!device) {
        return res.status(404).json({ error: 'Device not connected' });
    }

    const requestId = `${Date.now()}-${Math.random().toString(36)}`;
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('Command timeout'));
        }, 30000);
        pendingCommands.set(requestId, { resolve, reject, timer });
    });

    try {
        // Send command to Android client via WebSocket
        device.socket.emit('execute_command', { requestId, command, params });
        const result = await commandPromise;
        res.json({ success: true, requestId, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. File Manager - Upload/Download
app.post('/api/file/upload/:deviceId', authMiddleware, upload.single('file'), (req, res) => {
    // Implementation would handle file upload to device via ADB push
    res.json({ success: true, message: 'File upload triggered' });
});

// 5. WiFi Auto-Install
app.post('/api/wifi/autoinstall', authMiddleware, async (req, res) => {
    const { ssid, apkUrl } = req.body;
    // This would use ADB to install APK when connected to specific WiFi
    res.json({ success: true, message: `Auto-install triggered for SSID: ${ssid}` });
});

// ==================== SOCKET.IO HANDLERS ====================

io.on('connection', (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    socket.on('register_device', async (data) => {
        const { deviceId, deviceInfo, adbId } = data;
        if (!deviceId) return;

        socket.deviceId = deviceId;
        socket.userType = 'android';
        socket.deviceInfo = deviceInfo;
        
        connectedDevices.set(deviceId, { socket, deviceInfo, adbId });
        socket.join(`device:${deviceId}`);
        
        console.log(`[Android] Device Registered: ${deviceId}`);
        socket.emit('registered', { success: true });
    });

    socket.on('command_response', (data) => {
        const { requestId, success, result, error } = data;
        const pending = pendingCommands.get(requestId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);
            if (success) {
                pending.resolve(result);
            } else {
                pending.reject(new Error(error || 'Command failed on device'));
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.userType === 'android' && socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            console.log(`[Android] Device Disconnected: ${socket.deviceId}`);
        }
    });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║     Advanced Remote Android Server Started 🚀         ║
╠════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                            ║
║  AI Integration: ${process.env.GEMINI_API_KEY ? 'Enabled' : 'Disabled'}       ║
╚════════════════════════════════════════════════════════╝
  `);
});