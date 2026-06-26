import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { devices } from 'playwright';
import fs from 'fs';
import UserAgent from 'user-agents';
import axios from 'axios';

// Aktifkan mode Stealth agar tidak mudah terdeteksi sebagai Bot/Automation
const stealthPlugin = stealth();
// Hapus evasion bawaan yang sering bentrok dengan profil OS spesifik kita
stealthPlugin.enabledEvasions.delete('user-agent-override');
stealthPlugin.enabledEvasions.delete('navigator.vendor');
chromium.use(stealthPlugin);

let currentBrowser = null;
let isAborted = false;

// Global State
export const proxySuccess = new Set();
export const proxyFailed = new Set();
export const activeBots = new Map();

export function getActiveBots() {
    return Array.from(activeBots.keys()).map(botId => {
        const bot = activeBots.get(botId);
        return {
            id: botId,
            proxy: bot.proxy,
            device: bot.device,
            startTime: bot.startTime
        };
    });
}

export async function closeBot(botId) {
    const bot = activeBots.get(botId);
    if (bot && bot.context) {
        await bot.context.close().catch(() => { });
        activeBots.delete(botId);
    }
}

export async function viewBot(botId) {
    const bot = activeBots.get(botId);
    if (bot && bot.page) {
        try {
            await bot.page.bringToFront().catch(() => { });
            // Ambil screenshot layar saat ini untuk ditampilkan di Web Dashboard
            const buffer = await bot.page.screenshot({ type: 'jpeg', quality: 50, timeout: 5000 });
            return buffer.toString('base64');
        } catch (e) {
            return null;
        }
    }
    return null;
}

export function clearProxyData() {
    proxySuccess.clear();
    proxyFailed.clear();
}

function getProxies(proxyInput) {
    if (!proxyInput || proxyInput.trim() === '') {
        return [{ server: 'DIRECT (Tanpa Proxy)' }];
    }

    let data = '';
    if (proxyInput.includes('.txt') && fs.existsSync(proxyInput)) {
        data = fs.readFileSync(proxyInput, 'utf8');
    } else {
        data = proxyInput;
    }

    if (!data) return [{ server: 'DIRECT (Tanpa Proxy)' }];

    const lines = data.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

    return lines.map(line => {
        let scheme = 'http://';
        let remaining = line;

        if (remaining.includes('://')) {
            const splitIndex = remaining.indexOf('://');
            scheme = remaining.substring(0, splitIndex + 3);
            remaining = remaining.substring(splitIndex + 3);
        }

        const parts = remaining.split(':');
        if (parts.length >= 4) {
            return { server: `${scheme}${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
        } else if (parts.length >= 2) {
            return { server: `${scheme}${parts[0]}:${parts[1]}` };
        }
        return { server: `${scheme}${remaining}` };
    }).filter(p => p !== null);
}

export async function stopBot() {
    isAborted = true;

    // Paksa tutup semua context (tab) yang sedang aktif terlebih dahulu
    for (const [botId, bot] of activeBots.entries()) {
        if (bot.context) {
            bot.context.close().catch(() => { });
        }
    }
    activeBots.clear();

    if (currentBrowser) {
        // Berikan waktu penutupan browser lebih lama, tetapi tidak memblokir UI
        Promise.race([
            currentBrowser.close().catch(() => { }),
            new Promise(r => setTimeout(r, 5000))
        ]).then(() => {
            currentBrowser = null;
        });
    }
}

async function checkYouTubeBlock(page) {
    const blockReason = await page.evaluate(() => {
        // CEK LOGIN / IP BAN: Cari elemen dialog/overlay yang TERLIHAT
        const bodyText = document.body.innerText || '';
        const lower = bodyText.toLowerCase();

        // Deteksi layar login bot-check (halaman penuh, bukan elemen tersembunyi)
        if (lower.includes('sign in to confirm') && lower.includes('not a bot')) {
            return 'Terblokir: YouTube meminta Login (IP Banned)';
        }
        if (lower.includes('unusual traffic')) {
            return 'Terblokir: Unusual Traffic (Captcha)';
        }

        // Deteksi error player HANYA jika elemen error overlay BENAR-BENAR TERLIHAT di layar
        // Jangan gunakan innerText karena YouTube selalu embed teks ini di DOM tersembunyi!
        const errorEl = document.querySelector(
            '.ytp-error, .html5-video-player.ytp-error-overlay, yt-playability-error-supported-renderers'
        );
        if (errorEl) {
            const style = window.getComputedStyle(errorEl);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && errorEl.offsetHeight > 0;
            if (isVisible) {
                return 'Error Player: Something went wrong (Video gagal dimuat)';
            }
        }

        // Deteksi video tidak tersedia
        const unavailableEl = document.querySelector('.yt-playability-error-supported-renderers, #error-screen');
        if (unavailableEl && unavailableEl.offsetHeight > 0) {
            return 'Error: Video Tidak Tersedia';
        }

        return null;
    }).catch(() => null);

    if (blockReason) {
        throw new Error(blockReason);
    }
}

async function waitDuration(page, durationMs, botId, log) {
    const interval = 1000;
    let elapsed = 0;
    let refreshCount = 0;

    // Jadwalkan waktu scroll pertama (antara 5 sampai 15 detik setelah video mulai)
    let nextScrollTime = Math.floor(Math.random() * 10000) + 5000;
    let lastKnownTime = 0;

    while (elapsed < durationMs && !isAborted) {
        await page.waitForTimeout(Math.min(interval, durationMs - elapsed)).catch(() => { });
        elapsed += interval;

        // --- HUMAN SCROLLING BEHAVIOR ---
        if (elapsed >= nextScrollTime && !isAborted) {
            try {
                // Simulasikan aktivitas baca komentar / scroll rekomendasi dengan Native Events
                const scrollDownAmount = Math.floor(Math.random() * 800) + 300; 

                // 1. Scroll ke bawah menggunakan Trusted Mouse Wheel
                await page.mouse.wheel(0, scrollDownAmount).catch(() => {});

                // 2. Gerakkan mouse secara natural (Bezier curve/steps)
                const randomX = Math.floor(Math.random() * 800) + 50;
                const randomY = Math.floor(Math.random() * 600) + 50;
                await page.mouse.move(randomX, randomY, { steps: 10 }).catch(() => {});

                // 3. Baca-baca sebentar, lalu scroll kembali ke atas (Asynchronous)
                (async () => {
                    try {
                        const readDelay = Math.floor(Math.random() * 4000) + 2000;
                        await page.waitForTimeout(readDelay);
                        if (!isAborted) {
                            // Scroll balik ke atas
                            await page.mouse.wheel(0, -scrollDownAmount).catch(() => {});
                            // Gerakkan mouse kembali ke area video (tengah atas layar)
                            const winSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(()=>({w:800,h:600}));
                            await page.mouse.move(winSize.w / 2, winSize.h / 3, { steps: 15 }).catch(() => {});
                        }
                    } catch(e) {}
                })();

            } catch (e) {
                // Abaikan error jika halaman tertutup
            }

            // Jadwalkan waktu scroll berikutnya (antara 10 sampai 25 detik ke depan)
            nextScrollTime = elapsed + (Math.floor(Math.random() * 15000) + 10000);
        }

        // Terus pantau secara berkala apakah muncul error/login screen di tengah jalan
        if (elapsed % 2000 === 0) {
            // Track time continuously so we know the exact second if it crashes
            try {
                const ct = await page.evaluate(() => {
                    const vid = document.querySelector('video');
                    return vid && !vid.paused ? Math.floor(vid.currentTime) : -1;
                });
                if (ct > 0) lastKnownTime = ct;
            } catch(e) {}

            // Dismiss "Continue watching?" dialog, skip ads, & force play if paused
            try {
                const needsForcePlay = await page.evaluate(() => {
                    // 1. Auto Skip Iklan YouTube (Skip Ad)
                    const skipBtns = document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
                    for (let btn of skipBtns) {
                        if (btn.offsetWidth > 0 || btn.offsetHeight > 0) {
                            btn.click();
                        }
                    }

                    // 2. Tutup Banner Iklan Overlay yang muncul di tengah bawah video
                    const overlayCloseBtns = document.querySelectorAll('.ytp-ad-overlay-close-button');
                    for (let btn of overlayCloseBtns) {
                        if (btn.offsetWidth > 0 || btn.offsetHeight > 0) {
                            btn.click();
                        }
                    }

                    // 3. Dismiss dialog "Video paused. Continue watching?"
                    const dialogText = document.body.innerText.toLowerCase();
                    if (dialogText.includes('video paused') || dialogText.includes('continue watching')) {
                        const btns = document.querySelectorAll('yt-button-renderer[dialog-action="confirm"] button, #confirm-button button, .yt-confirm-dialog-renderer button');
                        for (let btn of btns) {
                            if (btn.offsetWidth > 0 || btn.offsetHeight > 0) {
                                btn.click();
                            }
                        }
                    }
                    
                    // 4. Paksa putar video jika ter-pause secara tak terduga (Tanpa memanggil vid.play() langsung karena terdeteksi bot)
                    const vid = document.querySelector('video');
                    const errorEl = document.querySelector('.ytp-error');
                    const hasError = errorEl && errorEl.offsetWidth > 0 && errorEl.style.display !== 'none';
                    
                    if (vid && vid.paused && !vid.ended && !hasError) {
                        return true;
                    }
                    return false;
                });
                
                if (needsForcePlay) {
                    await page.keyboard.press('k').catch(()=>{}); // Native keyboard shortcut for Play/Pause in YouTube
                }
            } catch (e) {}

            try {
                await checkYouTubeBlock(page);
            } catch (err) {
                if (err.message.includes('Something went wrong') && refreshCount < 3) {
                    refreshCount++;
                    
                    // Gunakan waktu terakhir yang tercatat sebelum crash
                    let lastTime = lastKnownTime;
                    log(`[${botId}] ⚠️ Terdeteksi error pemutaran video pada menit ${Math.floor(lastTime/60)}:${lastTime%60} (detik ke-${lastTime}). Melakukan auto-refresh halaman untuk melanjutkan...`);
                    
                    const currentUrl = page.url();
                    try {
                        const urlObj = new URL(currentUrl);
                        urlObj.searchParams.set('t', lastTime + 's');
                        await page.goto(urlObj.toString(), { waitUntil: 'domcontentloaded' }).catch(() => { });
                    } catch(e) {
                        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
                    }
                    
                    await autoPlay(page, botId, log); // Coba play lagi setelah refresh
                } else {
                    throw err; // Lempar ke atas jika error lain atau sudah sering di-refresh
                }
            }
        }
    }
    if (isAborted) throw new Error("Aborted");
}

async function autoPlay(page, botId, log) {
    await page.waitForTimeout(3000).catch(() => { });

    // 🔴 DETEKSI AWAL PROXY GAGAL (Diblokir YouTube / Error)
    await checkYouTubeBlock(page);

    let videoTitle = "Video YouTube";
    try {
        videoTitle = await page.evaluate(() => {
            const titleEl = document.querySelector('h1.title, h2.slim-video-metadata-title, .ytm-media-title, .watch-title, h1 .yt-core-attributed-string');
            if (titleEl) return titleEl.innerText.trim();
            return document.title.replace(' - YouTube', '').trim();
        });
    } catch (e) { }

    log(`[${botId}] 🟢 Memutar: "<span class="text-green-300 font-bold">${videoTitle}</span>"`);

    await page.waitForSelector('.html5-video-player', { timeout: 10000 }).catch(() => { });

    // Mute video terlebih dahulu agar kebijakan Autoplay browser mengizinkan
    await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) {
            video.muted = true;
        }
    }).catch(() => { });

    // Cek apakah video sedang pause. Jika iya, baru kita paksa play
    const isPaused = await page.evaluate(() => {
        const video = document.querySelector('video');
        return video ? video.paused : true;
    }).catch(() => true);

    if (isPaused) {
        // Coba Play via JS
        await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video && video.paused) {
                video.play().catch(() => { });
            }
        }).catch(() => { });

        // Coba klik tombol Play fisik raksasa (Hanya muncul jika diam)
        const playBtn = page.locator('.ytp-large-play-button').first();
        if (await playBtn.isVisible().catch(() => false)) {
            // Gunakan force true karena terkadang elemen UI bertumpuk (invisible overlay)
            await playBtn.click({ force: true }).catch(() => { });
        }
    }
}

export async function runBot(config, callbacks) {
    isAborted = false;
    const { log, onSuccess, onFailed, onVideoPlay, onVideoSuccess, onVideoFail, onUaUsed } = callbacks;
    const { videoUrl, recoUrl, recoDuration, proxyFile, headless, browserCount, ipMode, watchDurationMin, watchDurationMax, checkWhoer, userAgentMode, uaAssignmentMode, tabDelay, randomVideoUrl, trafficSource, searchKeyword, searchVideoId, embedWebUrl, useVpn, isLooping, loopCount } = config;
    const tabDelayMs = (tabDelay || 5) * 1000;

    let allProxies = getProxies(proxyFile);

    if (useVpn) {
        log(`🛡️ Mode VPN Terpercaya aktif. Sedang menyambungkan ke jaringan VPN Global...`);
        try {
            // Mengambil daftar premium/elite proxy terbaru (bekerja sebagai VPN per tab)
            const res = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=elite');
            if (res.data && res.data.length > 0) {
                // Jangan reset proxySuccess / Failed agar bisa lanjut.
                allProxies = getProxies(res.data);
                log(`✅ Berhasil menemukan ${allProxies.length} jalur VPN Elite/Anonymous.`);
            } else {
                throw new Error("Daftar VPN kosong");
            }
        } catch (e) {
            log(`<span class="text-yellow-400">⚠️ Gagal terhubung ke API VPN. Menggunakan proxy cadangan (jika ada).</span>`);
        }
    }

    // Antrean proxy hanya berisi proxy yang belum sukses dan belum gagal
    let proxyQueue = allProxies.filter(p => !proxySuccess.has(p.server) && !proxyFailed.has(p.server));

    if (proxyQueue.length === 0) {
        log(`<span class="text-yellow-400 font-bold">⚠️ Antrean Kosong: Semua proxy/VPN yang tersedia sudah terpakai. Silakan klik tombol 'Clear Proxy Data' atau coba lagi.</span>`);
        return;
    }

    log(`✅ Memuat ${proxyQueue.length} VPN/Proxy baru ke dalam antrean (Mengesampingkan yang sudah terpakai).`);

    log(`🚀 Meluncurkan Engine Browser... (Mode Siluman: ${headless ? 'Aktif' : 'Tidak'})`);

    const browserArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        // --- ANTI BACKGROUND THROTTLING (Wajib untuk Multi-Tab) ---
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion'
    ];

    // WAJIB pakai Chrome asli (bukan Chromium) karena YouTube membutuhkan Widevine DRM
    // Chromium bawaan Playwright TIDAK memiliki Widevine, sehingga video DRM gagal di detik 40
    try {
        log(`🚀 Mencoba meluncurkan Chrome asli (diperlukan untuk Widevine DRM)...`);
        currentBrowser = await chromium.launch({
            headless,
            channel: 'chrome',
            args: browserArgs
        });
        log(`✅ Chrome asli berhasil diluncurkan.`);
    } catch (e) {
        log(`⚠️ Chrome asli tidak ditemukan! Beralih ke Chromium (video DRM mungkin gagal di detik 40)...`);
        try {
            currentBrowser = await chromium.launch({
                headless,
                args: browserArgs
            });
        } catch (err) {
            log(`<span class="text-red-400">Gagal meluncurkan browser: ${err.message}</span>`);
            return;
        }
    }

    const browserVer = currentBrowser.version();
    const majorVer = browserVer.split('.')[0] || '124';
    
    const mode = userAgentMode || 'all';
    const customDesktopDevices = {
        'Macbook (Safari)': { ...devices['Desktop Safari'], userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' },
        'Macbook (Chrome)': { ...devices['Desktop Chrome'], userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVer}.0.0.0 Safari/537.36` },
        'Linux (Chrome)': { ...devices['Desktop Chrome'], userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVer}.0.0.0 Safari/537.36` },
        'Linux (Firefox)': { ...devices['Desktop Firefox'], userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0' },
        'Windows (Chrome)': { ...devices['Desktop Chrome'], userAgent: devices['Desktop Chrome'].userAgent.replace(/Chrome\/\d+/, `Chrome/${majorVer}`) },
        'Windows (Edge)': { ...devices['Desktop Edge'], userAgent: devices['Desktop Edge'].userAgent.replace(/Edg\/\d+/, `Edg/${majorVer}`).replace(/Chrome\/\d+/, `Chrome/${majorVer}`) }
    };
    const validDesktop = Object.keys(customDesktopDevices);
    const mobileDevices = [
        'Galaxy S8', 'Galaxy S9+', 'Galaxy S24', 'Galaxy A55', 
        'Pixel 3', 'Pixel 4', 'Pixel 4a (5G)', 'Pixel 5', 'Pixel 7',
        'Moto G4', 'Nexus 5X', 'Nexus 6P',
        'iPhone 11', 'iPhone 11 Pro Max', 'iPhone 12', 'iPhone 12 Pro Max',
        'iPhone 13', 'iPhone 13 Pro Max', 'iPhone 14', 'iPhone 14 Plus', 
        'iPhone 14 Pro Max', 'iPhone 15', 'iPhone 15 Pro Max', 'iPhone XR', 'iPhone SE (3rd gen)'
    ];
    const validMobile = mobileDevices.filter(d => devices[d]);

    let devicePool = [];
    if (mode === 'desktop') devicePool = validDesktop;
    else if (mode === 'mobile') devicePool = validMobile;
    else devicePool = [...validDesktop, ...validMobile];
    if (devicePool.length === 0) devicePool = ['Windows (Chrome)'];

    function getDeviceProfile() {
        const devName = devicePool[Math.floor(Math.random() * devicePool.length)];
        const isMob = validMobile.includes(devName);
        let devProfile = isMob ? { ...devices[devName] } : { ...customDesktopDevices[devName] };
        if (devProfile.userAgent && devProfile.userAgent.includes('Chrome/')) {
            devProfile.userAgent = devProfile.userAgent.replace(/Chrome\/\d+/, `Chrome/${majorVer}`);
        }
        const pStr = devName.includes('iPhone') ? 'iPhone' 
                   : devName.includes('Macbook') ? 'MacIntel' 
                   : devName.includes('Linux') ? 'Linux x86_64' 
                   : isMob ? 'Linux armv8l' : 'Win32';
        const oName = pStr === 'iPhone' ? 'iOS' 
                    : pStr === 'Linux armv8l' ? 'Android' 
                    : pStr === 'MacIntel' ? 'macOS' 
                    : pStr === 'Linux x86_64' ? 'Linux' : 'Windows';
        const oVer = pStr === 'iPhone' ? '17.4' 
                   : pStr === 'Linux armv8l' ? '14.0.0' 
                   : pStr === 'MacIntel' ? '10.15.7' 
                   : pStr === 'Linux x86_64' ? '6.5.0' : '10.0.0';
        return { devName, isMob, devProfile, pStr, oName, oVer };
    }

    let sharedProfile = null;
    if (uaAssignmentMode === 'same') {
        sharedProfile = getDeviceProfile();
        log(`🛡️ Mode UA Sama Aktif: Semua Tab akan menggunakan perangkat <span class="text-yellow-400 font-bold">${sharedProfile.devName}</span>`);
    }

    const maxLoop = isLooping ? (loopCount > 0 ? loopCount : Infinity) : 1;
    let currentLoop = 0;

    while (currentLoop < maxLoop && !isAborted) {
        currentLoop++;
        if (currentLoop > 1) {
            log(`<br><span class="text-purple-400 font-bold">🔄 LOOPING AKTIF: Memulai putaran ke-${currentLoop}${maxLoop === Infinity ? ' (Unlimited)' : ' dari ' + maxLoop}.</span><br>`);
            await new Promise(r => setTimeout(r, 5000));
        }

        log(`<br><span class="text-blue-400 font-bold">=================================================</span>`);
        const titleMode = ipMode === 'same' ? 'IP Sama' : 'IP Berbeda-beda';
        log(`<span class="text-blue-400 font-bold">🔄 WORKER POOL | Menjalankan ${browserCount} Worker Konstan (${titleMode})</span>`);
        log(`<span class="text-blue-400 font-bold">=================================================</span><br>`);

        // Helper untuk menjalankan 1 instance bot
        async function runSingleBot(proxyConfig, globalIndex, workerIndex, delayIndex) {
            if (isAborted) return;
            const botId = ipMode === 'same' ? `Bot-${workerIndex}` : `Bot-${globalIndex + 1}`;
            let context = null;
            let proxyTimezone = null;

            const serverLabel = useVpn ? 'VPN' : 'PROXY';
            const displayServer = proxyConfig.server === 'DIRECT (Tanpa Proxy)' ? 'DIRECT (IP Asli)' : proxyConfig.server;
            log(`[${botId}] 🌐 Menyiapkan ${serverLabel}: ${displayServer}`);

            if (proxyConfig.server !== 'DIRECT (Tanpa Proxy)') {
                try {
                    const url = new URL(proxyConfig.server);
                    const hostname = url.hostname;
                    const geoRes = await axios.get(`http://ip-api.com/json/${hostname}`, { timeout: 5000 });
                    if (geoRes.data && geoRes.data.status === 'success' && geoRes.data.timezone) {
                        proxyTimezone = geoRes.data.timezone;
                        log(`<span class="text-yellow-300">[${botId}] 🌍 Timezone: ${geoRes.data.country} (${proxyTimezone})</span>`);
                    }
                } catch (e) {
                    // Ignore if timezone detection fails
                }
            }

            // Jeda antar tab agar koneksi tidak bentrok secara bersamaan
            const delayMs = delayIndex * tabDelayMs;
            if (delayMs > 0) {
                log(`[${botId}] ⏳ Menunggu jeda ${tabDelay * delayIndex} detik sebelum membuka tab...`);
                let waited = 0;
                while (waited < delayMs && !isAborted) {
                    await new Promise(r => setTimeout(r, Math.min(1000, delayMs - waited)));
                    waited += 1000;
                }
            }

            if (!isAborted) {
                let contextOptions = { ignoreHTTPSErrors: true };

                if (proxyTimezone) {
                    contextOptions.timezoneId = proxyTimezone;
                }

                let currentProfile = uaAssignmentMode === 'same' ? sharedProfile : getDeviceProfile();
                const { devName: randomDeviceName, isMob: isMobileProfile, devProfile: deviceProfile, pStr: platformStr, oName: osName, oVer: osVersion } = currentProfile;

                log(`[${botId}] Standby... ${isMobileProfile ? '📱 Mobile' : '🖥️ Desktop'} (${randomDeviceName})`);

                contextOptions = { ...contextOptions, ...deviceProfile };

                // Force Playwright to use this exact User-Agent and Client Hints in Chromium arguments
                contextOptions.userAgent = deviceProfile.userAgent;
                
                contextOptions.extraHTTPHeaders = {
                    'sec-ch-ua-platform': `"${osName}"`,
                    'sec-ch-ua-platform-version': `"${osVersion}"`,
                    'sec-ch-ua-mobile': isMobileProfile ? '?1' : '?0',
                    'sec-ch-ua': `\"Chromium\";v=\"${majorVer}\", \"Google Chrome\";v=\"${majorVer}\", \"Not-A.Brand\";v=\"99\"`
                };

                log(`[${botId}] 🕵️ User Agent: ${deviceProfile.userAgent}`);
                // ------------------------------------------------------------

                if (onUaUsed) {
                    onUaUsed(isMobileProfile ? 'mobile' : 'desktop');
                }

                if (!isMobileProfile && contextOptions.viewport) {
                    contextOptions.viewport = {
                        width: contextOptions.viewport.width + Math.floor(Math.random() * 200) - 100,
                        height: contextOptions.viewport.height + Math.floor(Math.random() * 100) - 50
                    };
                }

                if (proxyConfig.server !== 'DIRECT (Tanpa Proxy)') {
                    contextOptions.proxy = proxyConfig;
                }

                try {
                    context = await currentBrowser.newContext(contextOptions);
                    const page = await context.newPage();
                    page.setDefaultTimeout(90000);

                    activeBots.set(botId, {
                        context,
                        page,
                        proxy: proxyConfig.server,
                        device: randomDeviceName,
                        startTime: Date.now()
                    });

                    await page.addInitScript((opts) => {
                        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
                        Object.defineProperty(document, 'hidden', { get: () => false });
                        window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

                        // Override User Agent secara paksa (Mencegah Stealth Plugin mengembalikannya ke OS Host)
                        try { Object.defineProperty(navigator, 'userAgent', { get: () => opts.ua }); } catch (e) { }
                        try { Object.defineProperty(navigator, 'appVersion', { get: () => opts.ua.replace('Mozilla/', '') }); } catch (e) { }

                        // Spoofing navigator & platform
                        try { Object.defineProperty(navigator, 'platform', { get: () => opts.platform }); } catch (e) { }
                        if (opts.platform === 'MacIntel' || opts.platform === 'iPhone') {
                            try { Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.' }); } catch (e) { }
                        } else if (opts.platform === 'Linux armv8l') {
                            try { Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' }); } catch (e) { }
                        }
                        
                        if (navigator.userAgentData) {
                            try { Object.defineProperty(navigator.userAgentData, 'platform', { get: () => opts.osName }); } catch (e) { }
                            try { Object.defineProperty(navigator.userAgentData, 'mobile', { get: () => opts.isMobile }); } catch (e) { }
                            
                            // Mencegah kebocoran OS asli lewat HighEntropyValues (Sangat penting untuk Chromium baru)
                            if(navigator.userAgentData.getHighEntropyValues) {
                                const originalGet = navigator.userAgentData.getHighEntropyValues.bind(navigator.userAgentData);
                                navigator.userAgentData.getHighEntropyValues = async (hints) => {
                                    const res = await originalGet(hints);
                                    if(hints.includes('platform')) res.platform = opts.osName;
                                    if(hints.includes('platformVersion')) res.platformVersion = opts.osVersion;
                                    if(hints.includes('architecture')) res.architecture = (opts.osName === 'macOS' || opts.isMobile) ? 'arm' : 'x86';
                                    if(hints.includes('model')) res.model = opts.isMobile ? 'Mobile Device' : '';
                                    return res;
                                };
                            }
                        }
                    }, { platform: platformStr, osName: osName, osVersion: osVersion, isMobile: isMobileProfile, ua: deviceProfile.userAgent });

                    await context.clearCookies().catch(() => { });
                    try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch (e) { }

                    if (isAborted) throw new Error("Aborted");

                    if (checkWhoer) {
                        log(`[${botId}] 1. Mengecek Whoer.net...`);
                        await page.goto('https://whoer.net/');
                        let whoerElapsed = 0;
                        let whoerScraped = false;
                        while (whoerElapsed < 10000 && !isAborted) {
                            await page.waitForTimeout(1000).catch(() => { });
                            whoerElapsed += 1000;
                            if (whoerElapsed === 5000 && !whoerScraped) {
                                whoerScraped = true;
                                try {
                                    const whoerInfo = await page.evaluate(() => {
                                        const b = document.body.innerText;
                                        const extract = (key) => {
                                            const regex = new RegExp(key + '\\s*\\n\\s*([^\\n]+)', 'i');
                                            const match = b.match(regex);
                                            if (match) return match[1].trim();
                                            const regex2 = new RegExp(key + '\\s+([^\\n]+)', 'i');
                                            const match2 = b.match(regex2);
                                            return match2 ? match2[1].trim() : '?';
                                        };
                                        const percentEl = document.querySelector('.meter-value, .your-ip-panel__percent-value');
                                        let anonymity = '?';
                                        if (percentEl) {
                                            anonymity = percentEl.innerText.trim();
                                        } else {
                                            const percentMatch = b.match(/(\d+%)/);
                                            if (percentMatch) anonymity = percentMatch[1];
                                        }
                                        return { Anonymity: anonymity, ISP: extract('ISP:'), DNS: extract('DNS:'), Proxy: extract('Proxy:'), Blacklist: extract('Blacklist:') };
                                    });
                                    log(`<span class="text-cyan-300 font-semibold">[${botId}] 🔎 Whoer: Disguise: ${whoerInfo.Anonymity} | ISP: ${whoerInfo.ISP} | DNS: ${whoerInfo.DNS} | Proxy: ${whoerInfo.Proxy}</span>`);
                                } catch (e) { }
                            }
                        }
                        if (isAborted) throw new Error("Aborted");
                    } else {
                        log(`[${botId}] 1. Cek Whoer.net Dilewati.`);
                    }

                    if (recoUrl && recoUrl.trim() !== '') {
                        log(`[${botId}] 2. Membuka Pancingan...`);
                        await page.goto(recoUrl);
                        await autoPlay(page, botId, log);
                        log(`[${botId}] Nonton Pancingan: ${recoDuration} detik...`);
                        await waitDuration(page, recoDuration * 1000, botId, log);
                    }

                    log(`[${botId}] 3. Membuka Target Utama...`);
                    if (trafficSource === 'search') {
                        log(`[${botId}] 🔎 Mencari kata kunci: "${searchKeyword}"`);
                        await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(searchKeyword)}`);
                        await page.waitForLoadState('domcontentloaded').catch(() => { });

                        let found = false;
                        for (let s = 0; s < 15; s++) {
                            if (isAborted) throw new Error("Aborted");
                            const videoLink = page.locator(`a[href*="/watch?v=${searchVideoId}"], a[href*="/shorts/${searchVideoId}"]`).first();
                            if (await videoLink.isVisible().catch(() => false)) {
                                log(`[${botId}] 🎯 Video ditemukan! Mengklik video...`);
                                await videoLink.click();
                                found = true;
                                break;
                            }
                            await page.evaluate(() => window.scrollBy(0, 800));
                            await page.waitForTimeout(1500).catch(() => { });
                        }

                        if (!found) {
                            throw new Error(`Video ID ${searchVideoId} tidak ditemukan dari kata kunci pencarian.`);
                        }
                    } else if (trafficSource === 'embed') {
                        log(`[${botId}] 🌐 Membuka website embed: ${embedWebUrl}`);
                        await page.goto(embedWebUrl);
                        await page.waitForLoadState('domcontentloaded').catch(() => { });

                        log(`[${botId}] 🟢 Melakukan scroll untuk memuat semua video...`);
                        await page.evaluate(async () => {
                            for (let idx = 1; idx <= 10; idx++) {
                                window.scrollTo(0, idx * 600);
                                await new Promise(r => setTimeout(r, 600));
                            }
                            window.scrollTo(0, 0);
                        });
                    } else {
                        await page.goto(videoUrl);
                    }

                    if (trafficSource !== 'embed') {
                        if (onVideoPlay) onVideoPlay();
                        await autoPlay(page, botId, log);
                    } else {
                        if (onVideoPlay) onVideoPlay();
                        log(`[${botId}] 🟢 Menjalankan semua video embed...`);

                        await page.waitForTimeout(5000);

                        const iframes = await page.locator('iframe').all();
                        let playedCount = 0;

                        for (const iframe of iframes) {
                            const src = await iframe.getAttribute('src').catch(() => '');
                            if (src && src.includes('youtube')) {
                                try {
                                    await iframe.scrollIntoViewIfNeeded().catch(() => { });
                                    await page.waitForTimeout(3000);

                                    const frame = await iframe.contentFrame();
                                    if (frame) {
                                        const playBtn = frame.locator('.ytp-large-play-button, .ytp-play-button').first();
                                        await playBtn.waitFor({ state: 'attached', timeout: 10000 }).catch(() => { });

                                        let clicked = false;
                                        if (await playBtn.isVisible().catch(() => false)) {
                                            await playBtn.click({ force: true }).then(() => { clicked = true; }).catch(() => { });
                                        }

                                        if (!clicked) {
                                            const box = await iframe.boundingBox();
                                            if (box) {
                                                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => { });
                                            }
                                        }

                                        try {
                                            await iframe.evaluate((el) => {
                                                const iframeDoc = el.contentDocument || el.contentWindow.document;
                                                const video = iframeDoc.querySelector('video');
                                                if (video) {
                                                    video.muted = false;
                                                    video.play().catch(() => { });
                                                }
                                                const btn = iframeDoc.querySelector('.ytp-large-play-button') || iframeDoc.querySelector('.ytp-play-button');
                                                if (btn) btn.click();
                                            });
                                        } catch (e) { }
                                    }
                                    playedCount++;
                                } catch (e) { }
                            }
                        }
                        log(`[${botId}] ✅ Berhasil memproses ${playedCount} video embed.`);
                    }

                    const parsedMin = parseInt(watchDurationMin, 10) || 120;
                    const parsedMax = parseInt(watchDurationMax, 10) || parsedMin;
                    
                    let currentWatchDuration = parsedMin;
                    if (parsedMax > parsedMin) {
                        currentWatchDuration = Math.floor(Math.random() * (parsedMax - parsedMin + 1)) + parsedMin;
                    }
                    log(`[${botId}] Nonton Target: ${currentWatchDuration} detik...`);
                    await waitDuration(page, currentWatchDuration * 1000, botId, log);
                    if (onVideoSuccess) onVideoSuccess();

                    log(`[${botId}] 4. Membuka Video Random Lainnya...`);
                    if (randomVideoUrl && randomVideoUrl.trim() !== '') {
                        await page.goto(randomVideoUrl);
                        await page.waitForLoadState('domcontentloaded').catch(() => { });
                        await autoPlay(page, botId, log);
                        log(`[${botId}] Menonton video random selama 60 detik...`);
                        await waitDuration(page, 60000, botId, log);
                    } else {
                        const clickedRelated = await page.evaluate(() => {
                            const thumbs = Array.from(document.querySelectorAll('a#thumbnail, a.ytm-compact-video-renderer, ytd-compact-video-renderer a, a.compact-media-item-image'));
                            const validThumbs = thumbs.filter(t => t.href && t.href.includes('/watch'));
                            if (validThumbs.length > 0) {
                                const rnd = validThumbs[Math.floor(Math.random() * validThumbs.length)];
                                rnd.click();
                                return true;
                            }
                            return false;
                        });
                        if (clickedRelated) {
                            await page.waitForLoadState('domcontentloaded').catch(() => { });
                            await autoPlay(page, botId, log);
                            log(`[${botId}] Menonton video terkait selama 60 detik...`);
                            await waitDuration(page, 60000, botId, log);
                        } else {
                            log(`[${botId}] ⚠️ Tidak menemukan video terkait.`);
                        }
                    }

                    log(`[${botId}] ✅ Sukses sesi ini.`);

                    log(`<span class="text-green-400 font-bold">✅ [${botId}] Selesai! ${serverLabel} ${displayServer} BERHASIL.</span>`);
                    if (!proxySuccess.has(proxyConfig.server)) {
                        proxySuccess.add(proxyConfig.server);
                        onSuccess(proxyConfig.server);
                    }

                } catch (error) {
                    if (error.message === "Aborted" || error.message.includes('Target page, context or browser has been closed') || isAborted) {
                        log(`[${botId}] 🛑 Sesi dihentikan paksa.`);
                    } else {
                        const errMsg = error.message.split('\n')[0];
                        log(`<span class="text-red-400">[${botId}] Error: ${errMsg}</span>`);
                        if (onVideoFail) onVideoFail();

                        log(`<span class="text-red-400 font-bold">☠️ [${botId}] GAGAL! ${serverLabel} ${displayServer}.</span>`);
                        if (!proxyFailed.has(proxyConfig.server)) {
                            proxyFailed.add(proxyConfig.server);
                            onFailed(proxyConfig.server, errMsg || "Gagal tidak diketahui");
                        }
                    }
                } finally {
                    activeBots.delete(botId);
                    if (context) {
                        await context.clearCookies().catch(() => { });
                        await context.close().catch(() => { });
                        context = null;
                    }
                }
            } // end of if (!isAborted)
        } // end of runSingleBot

        if (ipMode === 'same') {
            for (let i = 0; i < proxyQueue.length; i++) {
                if (isAborted) break;
                const currentProxy = proxyQueue[i];
                
                const workers = Array.from({ length: browserCount }).map((_, wIdx) => {
                    return runSingleBot(currentProxy, i, wIdx + 1, wIdx);
                });
                await Promise.allSettled(workers);
            }
        } else {
            let queueIndex = 0;
            const totalProxies = proxyQueue.length;
            
            const workers = Array.from({ length: browserCount }).map(async (_, wIdx) => {
                let firstRun = true;
                while (queueIndex < totalProxies && !isAborted) {
                    const i = queueIndex++;
                    const currentProxy = proxyQueue[i];
                    
                    // Delay only for the first batch of workers to avoid crashing on start
                    const delayIdx = firstRun ? wIdx : 0;
                    firstRun = false;
                    
                    await runSingleBot(currentProxy, i, wIdx + 1, delayIdx);
                }
            });
            await Promise.allSettled(workers);
        }
    } // end of while(currentLoop < maxLoop)

    if (isAborted) {
        log("<br><span class='text-yellow-400 font-bold'>🛑 Seluruh operasi bot telah dihentikan secara paksa oleh user.</span>");
    } else {
        log("<br>🎉 Antrean proxy telah habis diproses. Engine ditutup.");
    }

    if (currentBrowser) {
        await currentBrowser.close().catch(() => { });
        currentBrowser = null;
    }
}
