// index.js - Complete Backend Server for Render.com
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8 // 100MB for file transfers
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public')); // For a potential web panel

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Data Storage (In-Memory, for demo)
const connectedDevices = new Map(); // deviceId -> socket
const pendingCommands = new Map(); // requestId -> { resolve, reject, timer }

// --- Authentication Middleware ---
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (!token || token !== process.env.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing token' });
    }
    next();
};

// --- Web Terminal Endpoints (Data Access & Control) ---

// 1. Terminal - Get All Connected Devices
app.get('/api/devices', authMiddleware, (req, res) => {
    const devices = Array.from(connectedDevices.entries()).map(([id, socket]) => ({
        id: id,
        deviceInfo: socket.deviceInfo,
        connectedAt: socket.connectedAt
    }));
    res.json({ success: true, devices });
});

// 2. Terminal - Send Command to Device
app.post('/api/command/:deviceId', authMiddleware, async (req, res) => {
    const { deviceId } = req.params;
    const { command, params } = req.body;

    const socket = connectedDevices.get(deviceId);
    if (!socket) {
        return res.status(404).json({ error: 'Device not connected' });
    }

    const requestId = `${Date.now()}-${Math.random().toString(36)}`;
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('Command timeout'));
        }, 30000); // 30s timeout
        pendingCommands.set(requestId, { resolve, reject, timer });
    });

    try {
        socket.emit('execute_command', { requestId, command, params });
        const result = await commandPromise;
        res.json({ success: true, requestId, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Terminal - AI Assistant Endpoint
app.post('/api/ai/assist', authMiddleware, async (req, res) => {
    try {
        const { prompt, deviceId } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        
        let context = "You are an assistant for managing a remote Android device. Provide clear, concise answers. ";
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

// --- WiFi Auto-Install (Mock) ---
app.post('/api/wifi/autoinstall', authMiddleware, (req, res) => {
    const { ssid, apkUrl } = req.body;
    console.log(`[WiFi Auto-Install] Request for SSID: ${ssid}, APK: ${apkUrl}`);
    // In a real implementation, this would be a complex process involving
    // network detection and ADB/shell commands. For now, it's a placeholder.
    res.json({ 
        success: true, 
        message: `Auto-install triggered for SSID: ${ssid}. The device will install the APK when connected to this WiFi.`,
        note: "This is a mock response. Actual implementation requires client-side logic."
    });
});

// 4. Terminal - Get WiFi Details of Connected Device
app.get('/api/wifi/:deviceId', authMiddleware, async (req, res) => {
    // This just sends a command to the device to get its WiFi info
    const { deviceId } = req.params;
    const socket = connectedDevices.get(deviceId);
    if (!socket) {
        return res.status(404).json({ error: 'Device not connected' });
    }
    const requestId = `${Date.now()}-wifi`;
    const commandPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            reject(new Error('WiFi info request timeout'));
        }, 15000);
        pendingCommands.set(requestId, { resolve, reject, timer });
    });
    try {
        socket.emit('execute_command', { requestId, command: 'GET_WIFI_INFO', params: {} });
        const result = await commandPromise;
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- WebSocket Handling (Real-time Communication) ---
io.on('connection', (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    // Register as a Controller (e.g., Web Terminal)
    socket.on('register_controller', (data) => {
        socket.userType = 'controller';
        socket.emit('registered', { message: 'Controller registered successfully' });
        console.log(`[Controller] Registered: ${socket.id}`);
    });

    // Register as an Android Device
    socket.on('register_device', (data) => {
        const { deviceId, deviceInfo } = data;
        if (!deviceId) {
            socket.emit('error', { message: 'deviceId is required' });
            return;
        }

        socket.deviceId = deviceId;
        socket.userType = 'android';
        socket.deviceInfo = deviceInfo;
        socket.connectedAt = new Date().toISOString();

        connectedDevices.set(deviceId, socket);
        socket.join(`device:${deviceId}`);

        console.log(`[Android] Device Registered: ${deviceId} (${deviceInfo?.model || 'Unknown'})`);
        socket.emit('registered', { success: true, message: 'Device registered with server' });
    });

    // Handle Command Responses from Android Device
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

    // Handle Data Push from Device (e.g., periodic updates)
    socket.on('device_data', (data) => {
        const { type, content } = data;
        console.log(`[Data] Received ${type} from ${socket.deviceId}`);
        // You can forward this data to connected controllers
        socket.broadcast.emit('device_update', { deviceId: socket.deviceId, type, content });
    });

    // Handle Disconnection
    socket.on('disconnect', () => {
        if (socket.userType === 'android' && socket.deviceId) {
            connectedDevices.delete(socket.deviceId);
            console.log(`[Android] Device Disconnected: ${socket.deviceId}`);
            // Notify controllers
            socket.broadcast.emit('device_disconnected', { deviceId: socket.deviceId });
        } else if (socket.userType === 'controller') {
            console.log(`[Controller] Disconnected: ${socket.id}`);
        }
    });
});

// --- Server Start ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║     Remote Android Management Server Started 🚀        ║
╠════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                            ║
║  WebSocket: Ready                                      ║
║  AI Integration: ${process.env.GEMINI_API_KEY ? 'Enabled' : 'Disabled'}       ║
╚════════════════════════════════════════════════════════╝
  `);
});