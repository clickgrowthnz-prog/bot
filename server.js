const express = require('express');
const multer = require('multer');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure directories exist
const BOTS_DIR = path.join(__dirname, 'bots');
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// Store running processes
const runningBots = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, BOTS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.py' || ext === '.zip') {
            cb(null, true);
        } else {
            cb(new Error('Only .py and .zip files allowed'));
        }
    }
});

// API Routes
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const botId = uuidv4();
    const botName = req.file.originalname;
    const filePath = req.file.path;
    const fileType = path.extname(botName).toLowerCase() === '.py' ? 'py' : 'zip';
    
    // Store bot info
    const botInfo = {
        id: botId,
        name: botName,
        type: fileType,
        filePath: filePath,
        status: 'stopped',
        pid: null,
        createdAt: new Date().toISOString()
    };
    
    // Save to database (simple JSON file)
    let bots = [];
    if (fs.existsSync(path.join(BOTS_DIR, 'bots.json'))) {
        bots = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'bots.json')));
    }
    bots.push(botInfo);
    fs.writeFileSync(path.join(BOTS_DIR, 'bots.json'), JSON.stringify(bots, null, 2));
    
    res.json({ success: true, bot: botInfo });
});

app.get('/api/bots', (req, res) => {
    let bots = [];
    if (fs.existsSync(path.join(BOTS_DIR, 'bots.json'))) {
        bots = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'bots.json')));
    }
    res.json(bots);
});

app.post('/api/start/:id', (req, res) => {
    const botId = req.params.id;
    let bots = [];
    if (fs.existsSync(path.join(BOTS_DIR, 'bots.json'))) {
        bots = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'bots.json')));
    }
    
    const bot = bots.find(b => b.id === botId);
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    if (runningBots.has(botId)) {
        return res.json({ success: false, error: 'Bot already running' });
    }
    
    const logFile = path.join(LOGS_DIR, `${botId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    logStream.write(`[${new Date().toISOString()}] Starting bot: ${bot.name}\n`);
    
    // Run Python script
    const pythonProcess = spawn('python3', [bot.filePath], {
        cwd: BOTS_DIR
    });
    
    pythonProcess.stdout.on('data', (data) => {
        logStream.write(`[stdout] ${data.toString()}`);
    });
    
    pythonProcess.stderr.on('data', (data) => {
        logStream.write(`[stderr] ${data.toString()}`);
    });
    
    pythonProcess.on('close', (code) => {
        logStream.write(`[${new Date().toISOString()}] Process exited with code ${code}\n`);
        logStream.end();
        runningBots.delete(botId);
        
        // Update status
        bot.status = 'stopped';
        fs.writeFileSync(path.join(BOTS_DIR, 'bots.json'), JSON.stringify(bots, null, 2));
    });
    
    runningBots.set(botId, { process: pythonProcess, logStream });
    bot.status = 'running';
    bot.pid = pythonProcess.pid;
    fs.writeFileSync(path.join(BOTS_DIR, 'bots.json'), JSON.stringify(bots, null, 2));
    
    res.json({ success: true, pid: pythonProcess.pid });
});

app.post('/api/stop/:id', (req, res) => {
    const botId = req.params.id;
    
    if (!runningBots.has(botId)) {
        return res.json({ success: false, error: 'Bot not running' });
    }
    
    const botProcess = runningBots.get(botId);
    botProcess.process.kill('SIGTERM');
    botProcess.logStream.write(`[${new Date().toISOString()}] Stopped by user\n`);
    botProcess.logStream.end();
    runningBots.delete(botId);
    
    // Update status
    let bots = [];
    if (fs.existsSync(path.join(BOTS_DIR, 'bots.json'))) {
        bots = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'bots.json')));
    }
    const bot = bots.find(b => b.id === botId);
    if (bot) {
        bot.status = 'stopped';
        fs.writeFileSync(path.join(BOTS_DIR, 'bots.json'), JSON.stringify(bots, null, 2));
    }
    
    res.json({ success: true });
});

app.get('/api/logs/:id', (req, res) => {
    const botId = req.params.id;
    const logFile = path.join(LOGS_DIR, `${botId}.log`);
    
    if (fs.existsSync(logFile)) {
        const logs = fs.readFileSync(logFile, 'utf8');
        res.json({ logs: logs });
    } else {
        res.json({ logs: '' });
    }
});

app.delete('/api/delete/:id', (req, res) => {
    const botId = req.params.id;
    
    // Stop if running
    if (runningBots.has(botId)) {
        const botProcess = runningBots.get(botId);
        botProcess.process.kill();
        botProcess.logStream.end();
        runningBots.delete(botId);
    }
    
    // Remove from database and delete files
    let bots = [];
    if (fs.existsSync(path.join(BOTS_DIR, 'bots.json'))) {
        bots = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'bots.json')));
    }
    
    const bot = bots.find(b => b.id === botId);
    if (bot) {
        // Delete bot file
        if (fs.existsSync(bot.filePath)) {
            fs.unlinkSync(bot.filePath);
        }
        // Delete log file
        const logFile = path.join(LOGS_DIR, `${botId}.log`);
        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
        }
        
        bots = bots.filter(b => b.id !== botId);
        fs.writeFileSync(path.join(BOTS_DIR, 'bots.json'), JSON.stringify(bots, null, 2));
    }
    
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Bots directory: ${BOTS_DIR}`);
    console.log(`📝 Logs directory: ${LOGS_DIR}`);
});