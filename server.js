import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import multer from 'multer';

import { fileURLToPath } from 'url';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import si from 'systeminformation';
import { runBot, stopBot, proxySuccess, proxyFailed, clearProxyData, getActiveBots, closeBot, viewBot } from './bot.js';
import { runTikTokBot, stopTikTokBot } from './tiktokBot.js';
import { runSpotifyBot, stopSpotifyBot } from './spotifyBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Baca versi aplikasi dari package.json
const packageJsonPath = path.join(__dirname, 'package.json');
let appVersion = "1.0.0";
if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    appVersion = pkg.version;
}

const app = express();
const server = createServer(app);
const io = new Server(server);

// Handle IPC messages from main.js (Electron)
process.on('message', (msg) => {
    if (msg.type === 'update-status') {
        // Forward ke semua client web yang terhubung
        io.emit('ota-update-status', msg);
    }
});

// Cegah zombie process: jika parent process mati, matikan server
process.on('disconnect', () => {
    process.exit(0);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'))
    }
});
const upload = multer({ storage: storage });

app.post('/api/upload-media', upload.single('mediaFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ filePath: path.join(uploadDir, req.file.filename) });
});



let isRunning = false;

// ============================================
// GLOBAL VIDEO STATISTICS
// ============================================
let videoStats = { total: 0, success: 0, failed: 0 };
let uaStats = { total: 0, desktop: 0, mobile: 0 };

function resetVideoStats() {
    videoStats = { total: 0, success: 0, failed: 0 };
    uaStats = { total: 0, desktop: 0, mobile: 0 };
}

// ============================================
// SYSTEM MONITORING LOOP
// ============================================
let prevNetStats = null;
async function getSystemStats() {
    try {
        const [cpu, mem, graphics, net] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.graphics(),
            si.networkStats()
        ]);

        const cpuLoad = cpu.currentLoad.toFixed(1);
        const memUsed = ((mem.active / mem.total) * 100).toFixed(1);
        
        // GPU
        let gpuLoad = 0;
        let gpuName = 'N/A';
        if (graphics.controllers && graphics.controllers.length > 0) {
            const g = graphics.controllers[0];
            gpuName = (g.model || 'GPU').substring(0, 20);
            gpuLoad = g.utilizationGpu || 0;
        }

        // Network RX/TX in KB/s
        let rxKb = 0, txKb = 0;
        if (net && net.length > 0) {
            rxKb = ((net[0].rx_sec || 0) / 1024).toFixed(1);
            txKb = ((net[0].tx_sec || 0) / 1024).toFixed(1);
        }

        return { cpuLoad, memUsed, gpuLoad, gpuName, rxKb, txKb };
    } catch (e) {
        return { cpuLoad: 0, memUsed: 0, gpuLoad: 0, gpuName: 'N/A', rxKb: 0, txKb: 0 };
    }
}

// Emit system stats every 2 seconds to all connected clients
setInterval(async () => {
    const stats = await getSystemStats();
    io.emit('sys-stats', stats);
    io.emit('active-bots', getActiveBots());
}, 2000);


io.on('connection', (socket) => {
    socket.emit('status', isRunning ? 'running' : 'stopped');
    socket.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size });
    socket.emit('video-stats', videoStats);
    socket.emit('ua-stats', uaStats);
    
    // Kirim data proxy awal saat user buka web
    socket.emit('init-proxies', { 
        success: Array.from(proxySuccess), 
        failed: Array.from(proxyFailed) 
    });

    socket.on('clear-proxy-data', () => {
        clearProxyData();
        io.emit('stats', { success: 0, failed: 0 });
        io.emit('init-proxies', { success: [], failed: [] });
        io.emit('log', '<hr><span class="text-yellow-400 font-bold">🗑️ Data riwayat Proxy Sukses & Gagal telah dibersihkan dari memori server. Proxy dapat digunakan kembali.</span><hr>');
    });

    socket.on('close-bot', async (botId) => {
        await closeBot(botId);
        io.emit('active-bots', getActiveBots());
    });

    socket.on('view-bot', async (botId) => {
        const base64 = await viewBot(botId);
        if (base64) {
            socket.emit('bot-screenshot', { botId, image: 'data:image/jpeg;base64,' + base64 });
        }
    });


    socket.emit('app-version', appVersion);

    // OTA Update Listeners
    socket.on('check-update', () => {
        if (process.send) process.send({ type: 'check-update' });
    });
    
    socket.on('download-update', () => {
        if (process.send) process.send({ type: 'download-update' });
    });
    
    socket.on('install-update', () => {
        if (process.send) process.send({ type: 'install-update' });
    });
});

app.get('/api/fetch-proxifly', async (req, res) => {
    try {
        const response = await axios.get('https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt');
        res.json({ data: response.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: 'Bot sudah berjalan.' });
    }
    
    isRunning = true;
    resetVideoStats();
    io.emit('video-stats', videoStats);
    io.emit('ua-stats', uaStats);
    io.emit('status', 'running');
    io.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size });
    io.emit('log', '<hr><span class="text-green-400 font-bold">[SISTEM] Memproses Antrean Proxy Baru...</span>');
    res.json({ message: 'Bot dimulai' });

    try {
        const callbacks = {
            log: (msg) => io.emit('log', msg),
            onVideoPlay: () => {
                videoStats.total++;
                io.emit('video-stats', videoStats);
            },
            onVideoSuccess: () => {
                videoStats.success++;
                io.emit('video-stats', videoStats);
            },
            onVideoFail: () => {
                videoStats.failed++;
                io.emit('video-stats', videoStats);
            },
            onSuccess: (proxyStr) => { 
                io.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size }); 
                io.emit('proxy-success', proxyStr);
            },
            onFailed: (proxyStr, reason) => { 
                io.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size }); 
                io.emit('proxy-failed', { proxy: proxyStr, reason });
            },
            onUaUsed: (type) => {
                uaStats.total++;
                if (type === 'desktop') uaStats.desktop++;
                else uaStats.mobile++;
                io.emit('ua-stats', uaStats);
            }
        };
        await runBot(req.body, callbacks);
    } catch (err) {
        io.emit('log', `<span class="text-red-500 font-bold">Error fatal: ${err.message}</span>`);
        console.error(err);
    } finally {
        isRunning = false;
        io.emit('status', 'stopped');
    }
});

app.post('/api/stop', async (req, res) => {
    if (!isRunning) {
        return res.status(400).json({ error: 'Bot tidak sedang berjalan.' });
    }
    try {
        io.emit('log', '<span class="text-yellow-400 font-bold">⚠️ Menghentikan sisa antrean bot. Harap tunggu...</span>');
        await stopBot();
        res.json({ message: 'Proses penghentian dikirim.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/start-tiktok', async (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: 'Bot (sistem) sudah berjalan. Hentikan dulu yang aktif.' });
    }
    
    isRunning = true;
    io.emit('status', 'running');
    io.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size });
    io.emit('log', '<hr><span class="text-pink-400 font-bold">[TIKTOK] Memulai Bot TikTok...</span>');
    res.json({ message: 'TikTok Bot dimulai' });

    try {
        const callbacks = {
            log: (msg) => io.emit('log', msg),
            onSuccess: (proxyStr) => { 
                io.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size }); 
                io.emit('proxy-success', proxyStr);
            },
            onFailed: (proxyStr, reason) => { 
                io.emit('stats', { success: proxySuccess.size, failed: proxyFailed.size }); 
                io.emit('proxy-failed', { proxy: proxyStr, reason });
            }
        };
        await runTikTokBot(req.body, callbacks);
    } catch (err) {
        io.emit('log', `<span class="text-red-500 font-bold">Error fatal: ${err.message}</span>`);
        console.error(err);
    } finally {
        isRunning = false;
        io.emit('status', 'stopped');
    }
});

app.post('/api/stop-tiktok', async (req, res) => {
    if (!isRunning) {
        return res.status(400).json({ error: 'Bot tidak sedang berjalan.' });
    }
    try {
        io.emit('log', '<span class="text-yellow-400 font-bold">⚠️ Menghentikan TikTok bot. Harap tunggu...</span>');
        await stopTikTokBot();
        res.json({ message: 'Proses penghentian dikirim.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/start-spotify', async (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: 'Bot (sistem) sudah berjalan. Hentikan dulu yang aktif.' });
    }
    
    isRunning = true;
    io.emit('status', 'running');
    io.emit('stats', { success: 0, failed: 0 });
    io.emit('log', '<hr><span class="text-green-400 font-bold">[SPOTIFY] Memulai Bot Spotify...</span>');
    res.json({ message: 'Spotify Bot dimulai' });

    try {
        const callbacks = {
            log: (msg) => io.emit('log', msg),
            onSuccess: (proxyStr) => { 
                io.emit('proxy-success', proxyStr);
            },
            onFailed: (proxyStr, reason) => { 
                io.emit('proxy-failed', { proxy: proxyStr, reason });
            }
        };
        await runSpotifyBot(req.body, callbacks);
    } catch (err) {
        io.emit('log', `<span class="text-red-500 font-bold">Error fatal: ${err.message}</span>`);
        console.error(err);
    } finally {
        isRunning = false;
        io.emit('status', 'stopped');
    }
});

app.post('/api/stop-spotify', async (req, res) => {
    if (!isRunning) {
        return res.status(400).json({ error: 'Bot tidak sedang berjalan.' });
    }
    try {
        io.emit('log', '<span class="text-yellow-400 font-bold">⚠️ Menghentikan Spotify bot. Harap tunggu...</span>');
        await stopSpotifyBot();
        res.json({ message: 'Proses penghentian dikirim.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// PROXY FINDER MODULE
// ============================================
let isChecking = false;

app.post('/api/find-proxies', async (req, res) => {
    if (isChecking) return res.status(400).json({ error: 'Sedang mengecek proxy. Tunggu sampai selesai.' });
    
    const { type, count, country } = req.body;
    isChecking = true;
    
    res.json({ message: 'Memulai pencarian...' });
    
    io.emit('finder-log', `<span class="text-cyan-400 font-bold">🔍 Mengambil daftar proxy secara menyeluruh (Negara: ${country || 'ALL'})...</span>`);
    io.emit('finder-status', 'SEARCHING');
    
    try {
        let proxyList = [];
        let proxySet = new Set();
        const targetCountry = country && country !== 'all' ? country.toUpperCase() : 'all';
        
        try {
            // ProxyScrape mendukung filter negara
            const url = `https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=${targetCountry}&ssl=all&anonymity=all`;
            const res1 = await axios.get(url, { timeout: 10000 });
            res1.data.split('\n').map(p => p.trim()).forEach(p => { if(p.length > 5) proxySet.add(p); });
            io.emit('finder-log', `<span class="text-gray-400">✅ Source 1 (ProxyScrape): ${proxySet.size} proxies.</span>`);
        } catch(e) {}
        
        if (targetCountry === 'all') {
            try {
                const res2 = await axios.get('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', { timeout: 10000 });
                res2.data.split('\n').map(p => p.trim()).forEach(p => { if(p.length > 5) proxySet.add(p); });
                io.emit('finder-log', `<span class="text-gray-400">✅ Source 2 (TheSpeedX): Total jadi ${proxySet.size} proxies.</span>`);
            } catch(e) {}
            
            try {
                const res3 = await axios.get('https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', { timeout: 10000 });
                res3.data.split('\n').map(p => p.trim()).forEach(p => { if(p.length > 5) proxySet.add(p); });
                io.emit('finder-log', `<span class="text-gray-400">✅ Source 3 (Monosans): Total jadi ${proxySet.size} proxies.</span>`);
            } catch(e) {}
        }

        proxyList = Array.from(proxySet).sort(() => 0.5 - Math.random());

        // Limit checking scope agar tidak terlalu lama, tapi cukup besar untuk dapat "residential" atau proxy bagus
        proxyList = proxyList.slice(0, count * 15);

        if (proxyList.length === 0) throw new Error("Gagal mengambil daftar proxy atau tidak ada proxy untuk negara tersebut.");

        io.emit('finder-log', `<span class="text-yellow-400">⚡ Ditemukan ${proxyList.length} proxy mentah. Memulai proses validasi koneksi ke YouTube...</span>`);
        io.emit('finder-status', 'CHECKING');

        const batchSize = 10;
        let foundCount = 0;

        for (let i = 0; i < proxyList.length; i += batchSize) {
            if (!isChecking) break;
            const batch = proxyList.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (proxy) => {
                if (!isChecking || foundCount >= count) return;
                try {
                    const agent = new HttpsProxyAgent(`http://${proxy}`);
                    const start = Date.now();
                    await axios.get('https://www.youtube.com/', { 
                        httpsAgent: agent,
                        timeout: 5000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                    });
                    const ping = Date.now() - start;
                    
                    foundCount++;
                    io.emit('finder-log', `<span class="text-green-400 font-bold">✅ VALID (${ping}ms) - ${proxy}</span>`);
                    io.emit('proxy-found', proxy);
                } catch (error) {
                    io.emit('finder-log', `<span class="text-red-500">❌ DEAD - ${proxy}</span>`);
                }
            }));
            
            if (foundCount >= count) break;
        }

        io.emit('finder-log', `<hr><span class="text-cyan-400 font-bold">🎉 Pencarian Selesai! Mendapatkan proxy bagus.</span><hr>`);
    } catch (err) {
        io.emit('finder-log', `<span class="text-red-500 font-bold">Error: ${err.message}</span>`);
    } finally {
        isChecking = false;
        io.emit('finder-status', 'IDLE');
    }
});

app.post('/api/stop-finder', (req, res) => {
    isChecking = false;
    res.json({ message: 'Pencarian dihentikan' });
});

app.post('/api/check-proxies', async (req, res) => {
    if (isChecking) return res.status(400).json({ error: 'Sedang mengecek proxy. Tunggu sampai selesai.' });
    
    const { proxies } = req.body;
    if (!proxies) return res.status(400).json({ error: 'Daftar proxy kosong.' });

    isChecking = true;
    res.json({ message: 'Memulai pengecekan manual...' });

    let proxyList = proxies.split('\n').map(p => p.trim()).filter(p => p.length > 5);
    io.emit('finder-log', `<span class="text-cyan-400 font-bold">🔍 Memulai Cek Manual untuk ${proxyList.length} proxy ke YouTube...</span>`);
    io.emit('finder-status', 'CHECKING');

    try {
        const batchSize = 10;
        for (let i = 0; i < proxyList.length; i += batchSize) {
            if (!isChecking) break;
            const batch = proxyList.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (proxy) => {
                if (!isChecking) return;
                
                let proxyUrl = proxy;
                if (!proxyUrl.includes('://')) {
                    proxyUrl = `http://${proxyUrl}`;
                }
                
                try {
                    const agent = new HttpsProxyAgent(proxyUrl);
                    const start = Date.now();
                    await axios.get('https://www.youtube.com/', { 
                        httpsAgent: agent,
                        timeout: 5000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                    });
                    const ping = Date.now() - start;
                    
                    io.emit('finder-log', `<span class="text-green-400 font-bold">✅ VALID (${ping}ms) - ${proxy}</span>`);
                    io.emit('proxy-found', proxy);
                } catch (error) {
                    io.emit('finder-log', `<span class="text-red-500">❌ DEAD - ${proxy}</span>`);
                }
            }));
        }

        io.emit('finder-log', `<hr><span class="text-cyan-400 font-bold">🎉 Pengecekan Selesai!</span><hr>`);
    } catch (err) {
        io.emit('finder-log', `<span class="text-red-500 font-bold">Error: ${err.message}</span>`);
    } finally {
        isChecking = false;
        io.emit('finder-status', 'IDLE');
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n=================================================`);
    console.log(`🚀 SERVER DASHBOARD SIAP!`);
    console.log(`Buka browser Anda dan kunjungi: http://localhost:3000`);
    console.log(`=================================================\n`);
});
