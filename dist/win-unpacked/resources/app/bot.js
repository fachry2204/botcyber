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
export const usedFingerprints = new Map(); // Untuk mencatat history fingerprint 24 jam

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

        // Error-screen untuk video yang dihapus atau di-private
        const unavailableEl = document.querySelector('#error-screen, .yt-playability-error-supported-renderers');
        if (unavailableEl && unavailableEl.offsetHeight > 0) {
            // Pastikan elemen benar-benar terlihat
            const style = window.getComputedStyle(unavailableEl);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return 'Error: Video Tidak Tersedia';
            }
        }
        
        // Deteksi layar "Something went wrong" (Hanya jika benar-benar merusak pemutaran)
        if (bodyText.includes('Something went wrong') && (bodyText.includes('Refresh or try again') || bodyText.includes('Playback'))) {
            const vid = document.querySelector('video');
            // Pastikan video benar-benar mati/pause akibat error ini
            if (!vid || vid.paused || vid.ended) {
                // Konfirmasi ke DOM apakah overlay error sungguhan tampil
                const errBox = document.querySelector('.ytm-error-overlay, .ytp-error');
                if (errBox && errBox.offsetHeight > 0) {
                    return 'Error Player: Something went wrong (Video gagal dimuat)';
                }
            }
        }



        return null;
    }).catch(() => null);

    if (blockReason) {
        throw new Error(blockReason);
    }
}

async function waitDuration(page, durationMs, botId, log, config = {}) {
    const interval = 1000;
    let elapsed = 0;
    let refreshCount = 0;

    // Jadwalkan waktu scroll pertama (antara 5 sampai 15 detik setelah video mulai)
    let nextScrollTime = Math.floor(Math.random() * 10000) + 5000;
    let lastKnownTime = 0;
    
    let hasLiked = false;
    let hasSubscribed = false;

    while (elapsed < durationMs && !isAborted) {
        await page.waitForTimeout(Math.min(interval, durationMs - elapsed)).catch(() => { });
        elapsed += interval;

        if (config.useCookies) {
            if (config.autoLike && elapsed > 10000 && !hasLiked && !isAborted) {
                hasLiked = true;
                try {
                    const isLiked = await page.evaluate(() => {
                        const btn = document.querySelector('button[aria-label^="Unlike this video"], button[aria-pressed="true"] .yt-spec-icon-shape');
                        if (btn) return true;
                        const likeBtn = document.querySelector('like-button-view-model button, segmented-like-dislike-button-view-model button, ytd-menu-renderer button');
                        return likeBtn && likeBtn.getAttribute('aria-pressed') === 'true';
                    });

                    if (isLiked) {
                        log(`[${botId}] 👍 Video ini sudah di-Like sebelumnya. (Dilewati)`);
                    } else {
                        log(`[${botId}] 👍 Video belum di-Like. Memberikan Like...`);
                        const likeBtn = page.locator('like-button-view-model button, segmented-like-dislike-button-view-model button, ytd-menu-renderer button[aria-label^="Like this video"]').first();
                        if (await likeBtn.isVisible().catch(() => false)) {
                            await likeBtn.click({ force: true }).catch(() => {});
                            await page.waitForTimeout(1000);
                        }
                    }
                } catch(e) {}
            }

            if (config.autoSubscribe && elapsed > 15000 && !hasSubscribed && !isAborted) {
                hasSubscribed = true;
                try {
                    const isSubscribed = await page.evaluate(() => {
                        const btn = document.querySelector('ytd-subscribe-button-renderer button, subscribe-button-view-model button');
                        if (!btn) return false;
                        const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
                        return text.includes('subscribed') || text.includes('disubscribe') || btn.getAttribute('aria-pressed') === 'true' || btn.querySelector('[aria-label*="Subscribed"]');
                    });

                    if (isSubscribed) {
                        log(`[${botId}] 🔔 Channel sudah di-Subscribe sebelumnya. (Dilewati)`);
                    } else {
                        log(`[${botId}] 🔔 Channel belum di-Subscribe. Melakukan Subscribe...`);
                        const subBtn = page.locator('ytd-subscribe-button-renderer button, subscribe-button-view-model button').first();
                        if (await subBtn.isVisible().catch(() => false)) {
                            await subBtn.click({ force: true }).catch(() => {});
                            await page.waitForTimeout(1000);
                        }
                    }
                } catch(e) {}
            }
        }

        // --- HUMAN INTERACTION (SUPER ACAK) ---
        if (elapsed >= nextScrollTime && !isAborted) {
            try {
                // Pilih salah satu dari 4 aksi manusia secara acak (0, 1, 2, 3)
                const actionType = Math.floor(Math.random() * 4); 
                const winSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(()=>({w:800,h:600}));

                if (actionType === 0) {
                    // Aksi 0: Mouse Jiggling (Menggerakkan mouse ke tengah player untuk memunculkan tombol, lalu keluar)
                    log(`[${botId}] 🖱️ Human Interaction: Menggerakkan mouse (Jiggling) di layar...`);
                    await page.mouse.move(winSize.w / 2, winSize.h / 3, { steps: 15 }).catch(() => {});
                    await page.waitForTimeout(1000);
                    await page.mouse.move(10, 10, { steps: 10 }).catch(() => {}); // Tarik keluar kursor
                } 
                else if (actionType === 1) {
                    // Aksi 1: Baca Komentar (Scroll jauh ke bawah, diam 10-15 detik, scroll balik)
                    log(`[${botId}] 📜 Human Interaction: Scroll turun ke area komentar untuk membaca...`);
                    const scrollAmount = Math.floor(Math.random() * 1500) + 800; // Scroll sejauh 800-2300px
                    await page.mouse.wheel(0, scrollAmount).catch(() => {});
                    await page.mouse.move(winSize.w / 2, winSize.h / 2 + 200, { steps: 10 }).catch(() => {});
                    
                    // Membaca secara Asynchronous agar timer bot utama tidak macet
                    (async () => {
                        try {
                            const readDelay = Math.floor(Math.random() * 10000) + 10000; // 10 sampai 20 detik
                            await page.waitForTimeout(readDelay);
                            if (!isAborted) {
                                await page.mouse.wheel(0, -scrollAmount).catch(() => {}); // Balik ke video
                                await page.mouse.move(winSize.w / 2, winSize.h / 4, { steps: 10 }).catch(() => {});
                            }
                        } catch(e) {}
                    })();
                }
                else if (actionType === 2) {
                    // Aksi 2: Random Pause/Play (Simulasi jeda ke toilet / angkat telepon)
                    log(`[${botId}] ⏸️ Human Interaction: Jeda video sejenak (Simulasi toilet break)...`);
                    await page.keyboard.press('k').catch(()=>{}); // Native pause YouTube
                    
                    (async () => {
                        try {
                            const pauseDuration = Math.floor(Math.random() * 8000) + 4000; // Jeda 4 - 12 detik
                            await page.waitForTimeout(pauseDuration);
                            if (!isAborted) {
                                await page.keyboard.press('k').catch(()=>{}); // Play kembali
                            }
                        } catch(e) {}
                    })();
                }
                else if (actionType === 3) {
                    // Aksi 3: Klik Sembarang / Hover (Simulasi membaca deskripsi)
                    const scrollAmount = Math.floor(Math.random() * 400) + 200; 
                    await page.mouse.wheel(0, scrollAmount).catch(() => {});
                    await page.mouse.move(winSize.w / 3, winSize.h / 2, { steps: 12 }).catch(() => {});
                    (async () => {
                        try {
                            await page.waitForTimeout(3000);
                            if (!isAborted) await page.mouse.wheel(0, -scrollAmount).catch(() => {});
                        } catch(e) {}
                    })();
                }

            } catch (e) {
                // Abaikan error misal tab keburu ditutup
            }

            // Jadwalkan waktu interaksi super acak berikutnya (antara 20 sampai 45 detik ke depan)
            nextScrollTime = elapsed + (Math.floor(Math.random() * 25000) + 20000);
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

            // 0. Deteksi dan Interaksi Iklan YouTube
            try {
                const hasAd = await page.evaluate(() => {
                    return document.querySelector('.ytp-ad-player-overlay, .ad-showing, ytm-promoted-sparkles-web-renderer, .ad-container') !== null;
                });
                
                if (hasAd) {
                    if (!page.adAppearedLogged) {
                        log(`[${botId}] 📺 Iklan mulai tayang/muncul di layar.`);
                        page.adAppearedLogged = true; // Flag to prevent spamming the log
                    }

                    if (config.clickAds && !isAborted && !page.adClickedLogged) {
                        const adTextSelectors = [
                            'Visit Advertiser', 'Kunjungi pengiklan', 'Get quote', 'Dapatkan penawaran',
                            'Order now', 'Pesan sekarang', 'Shop now', 'Beli sekarang',
                            'Learn more', 'Pelajari selengkapnya', 'Nantikan', 'Buka', 'Kunjungi situs',
                            'Visit site', 'Start now', 'Install', 'Instal', 'Download', 'Unduh',
                            'Sign up', 'Daftar', 'Play now', 'Mainkan'
                        ];
                        const textLocators = adTextSelectors.map(t => `a:has-text("${t}"), button:has-text("${t}")`).join(', ');
                        
                        // Hapus class generik seperti .ytp-ad-button dan .ytp-ad-visit-advertiser-info agar tidak nyasar ke tombol info (i)
                        const classLocators = '.ytp-ad-visit-advertiser-button, .ytp-ad-action-interstitial-action-button, a[aria-label="Visit advertiser"], ytm-promoted-sparkles-web-renderer a.ad-action-button, ytm-companion-ad-renderer .ad-action-button, .ytm-custom-ad-action-button';
                        
                        const adClickBtn = page.locator(`${textLocators}, ${classLocators}`).first();
                        
                        if (await adClickBtn.isVisible().catch(() => false)) {
                            log(`[${botId}] 💰 Iklan YouTube otomatis diklik...`);
                            page.adClickedLogged = true; // Prevent multiple clicks on the same ad
                            
                            try {
                                const context = page.context();
                                // Klik normal (tanpa Control) karena YouTube otomatis membuka tab baru (window.open / target=_blank)
                                const [newPage] = await Promise.all([
                                    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
                                    adClickBtn.click({ force: true }).catch(() => {})
                                ]);
                                
                                if (newPage) {
                                    await newPage.bringToFront().catch(()=>{});
                                    log(`[${botId}] 🌐 Tab iklan terbuka. Melakukan scroll atas/bawah selama 10 detik...`);
                                    await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(()=>{});
                                    
                                    // Scroll atas bawah secara natural selama ~10 detik (10 kali iterasi x 1 detik)
                                    for(let i = 0; i < 10; i++) {
                                        if (isAborted) break;
                                        await newPage.evaluate(() => {
                                            window.scrollBy(0, Math.random() * 500 + 200);
                                        }).catch(()=>{});
                                        await newPage.waitForTimeout(500);
                                        
                                        await newPage.evaluate(() => {
                                            window.scrollBy(0, -(Math.random() * 200 + 100));
                                        }).catch(()=>{});
                                        await newPage.waitForTimeout(500);
                                    }
                                    
                                    await newPage.close().catch(()=>{});
                                    log(`[${botId}] 🔙 Selesai interaksi iklan. Kembali menonton video YouTube.`);
                                    await page.bringToFront().catch(()=>{});
                                } else {
                                    log(`[${botId}] ⚠️ Iklan diklik, tetapi tab baru tidak terdeteksi (mungkin dicegah browser).`);
                                    await page.waitForTimeout(1500);
                                }
                            } catch (err) {
                                await page.waitForTimeout(1500);
                            }
                        }
                    } else if (!config.clickAds && !page.adSkippedLogged) {
                        log(`[${botId}] ⏭️ Iklan dibiarkan (Auto Click Ads tidak aktif).`);
                        page.adSkippedLogged = true;
                    }
                } else {
                    // Reset flags when ad disappears
                    page.adAppearedLogged = false;
                    page.adClickedLogged = false;
                    page.adSkippedLogged = false;
                }
            } catch (e) {}

            // Dismiss "Continue watching?" dialog, skip ads, & force play if paused
            try {
                const needsForcePlay = await page.evaluate(() => {
                    // 1. Auto Skip Iklan YouTube (Skip Ad)
                    const skipBtns = document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[class*="skip-ad"], .ytm-custom-ad-action-button');
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
                    let lastTime = lastKnownTime;
                    log(`[${botId}] ⚠️ Terdeteksi error pemutaran video (Something went wrong) pada detik ke-${lastTime}. Melakukan auto-refresh...`);
                    
                    try {
                        const urlObj = new URL(page.url());
                        urlObj.searchParams.set('t', lastTime + 's');
                        await page.goto(urlObj.toString(), { waitUntil: 'domcontentloaded' }).catch(() => { });
                    } catch(e) {
                        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
                    }
                    
                    await autoPlay(page, botId, log); // Coba play lagi setelah refresh
                } else {
                    throw err; // Error permanen (Captcha/Banned) atau sudah terlalu sering refresh
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
            const titleEl = document.querySelector('h1.title, h2.slim-video-metadata-title, .ytm-media-title, .watch-title, h1 .yt-core-attributed-string, yt-formatted-string.title.ytmusic-player-bar');
            if (titleEl) return titleEl.innerText.trim();
            return document.title.replace(' - YouTube', '').replace(' - YouTube Music', '').trim();
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
        // Coba Play menggunakan Native Keyboard Shortcut ('k' = play/pause)
        // Dilarang keras menggunakan JS video.play() karena akan ditandai sebagai Bot oleh YouTube BotGuard!
        await page.keyboard.press('k').catch(() => { });
        await page.waitForTimeout(500);

        // Coba klik tombol Play fisik raksasa (Hanya muncul jika diam)
        const playBtn = page.locator('.ytp-large-play-button, #play-pause-button').first();
        if (await playBtn.isVisible().catch(() => false)) {
            // Gunakan force true karena terkadang elemen UI bertumpuk (invisible overlay)
            await playBtn.click({ force: true }).catch(() => { });
        }
    }
}

export async function runBot(config, callbacks) {
    isAborted = false;
    const { log, onSuccess, onFailed, onVideoPlay, onVideoSuccess, onVideoFail, onUaUsed } = callbacks;
    const { videoUrl, recoUrl, recoDuration, proxyFile, headless, browserCount, ipMode, watchDurationMin, watchDurationMax, checkWhoer, userAgentMode, uaAssignmentMode, tabDelay, randomVideoUrl, trafficSource, searchKeyword, searchVideoId, embedWebUrl, externalUrl, useVpn, isLooping, loopCount, targetPlatform, clickAds, useCookies, cookieFileContent, autoLike, autoSubscribe } = config;
    const tabDelayMs = (tabDelay || 5) * 1000;
    const isMusic = targetPlatform === 'music';

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
    // Mengambil SEMUA profil HP (Mobile & Tablet) yang ada di database raksasa Playwright
    // Memfilter perangkat yang mendukung layar sentuh (hasTouch) dan bukan varian "landscape" agar tampilan video normal
    const validMobile = Object.keys(devices).filter(name => {
        const dev = devices[name];
        return dev.hasTouch && !name.toLowerCase().includes('landscape') && !name.toLowerCase().includes('desktop');
    });

    let devicePool = [];
    if (mode === 'desktop') devicePool = validDesktop;
    else if (mode === 'mobile') devicePool = validMobile;
    else devicePool = [...validDesktop, ...validMobile];
    if (devicePool.length === 0) devicePool = ['Windows (Chrome)'];

    function getDeviceProfile(botId, logCallback) {
        const now = Date.now();
        // Bersihkan fingerprint yang lebih tua dari 24 jam (86400000 ms)
        for (const [fp, time] of usedFingerprints.entries()) {
            if (now - time > 86400000) {
                usedFingerprints.delete(fp);
            }
        }

        let attempts = 0;
        while (attempts < 1000) {
            const devName = devicePool[Math.floor(Math.random() * devicePool.length)];
            const cores = [2, 4, 6, 8, 12, 16][Math.floor(Math.random() * 6)];
            const memory = [2, 4, 8, 16, 32][Math.floor(Math.random() * 5)];
            const vendors = ['Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Apple'];
            const renderers = ['Intel(R) UHD Graphics', 'NVIDIA GeForce RTX 3060', 'AMD Radeon(TM) Graphics', 'Apple M1', 'Adreno (TM) 640'];
            const vendor = vendors[Math.floor(Math.random() * vendors.length)];
            const renderer = renderers[Math.floor(Math.random() * renderers.length)];

            // Buat signature unik untuk mencegah duplikasi perangkat
            const signature = `${devName}_${cores}C_${memory}G_${vendor.split(' ')[0]}_${renderer.replace(/ /g, '')}`;

            if (usedFingerprints.has(signature) && uaAssignmentMode !== 'same') {
                if (logCallback) logCallback(`[${botId}] ⚠️ Peringatan: Profil/Fingerprint ${signature} sudah digunakan dalam 24 jam terakhir. Mengacak ulang...`);
                attempts++;
                continue;
            }

            // Tandai bahwa fingerprint ini sekarang sudah digunakan
            if (uaAssignmentMode !== 'same' || attempts === 0) {
                usedFingerprints.set(signature, now);
                if (logCallback) logCallback(`[${botId}] 🧬 Sidik jari perangkat unik didaftarkan: ${signature}`);
            }

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
                       
            return { devName, isMob, devProfile, pStr, oName, oVer, cores, memory, vendor, renderer };
        }
    }

    let sharedProfile = null;
    if (uaAssignmentMode === 'same') {
        sharedProfile = getDeviceProfile("Sistem", log);
        log(`🛡️ Mode UA Sama Aktif: Semua Tab akan menggunakan perangkat <span class="text-yellow-400 font-bold">${sharedProfile.devName}</span>`);
    }

    const maxLoop = isLooping ? (loopCount > 0 ? loopCount : Infinity) : 1;

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

                let currentProfile = uaAssignmentMode === 'same' ? sharedProfile : getDeviceProfile(botId, log);
                const { devName: randomDeviceName, isMob: isMobileProfile, devProfile: deviceProfile, pStr: platformStr, oName: osName, oVer: osVersion, cores, memory, vendor, renderer } = currentProfile;

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

                        // Mengacak Spesifikasi Hardware
                        try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => opts.cores }); } catch (e) { }
                        try { Object.defineProperty(navigator, 'deviceMemory', { get: () => opts.memory }); } catch (e) { }
                        
                        // Mengacak Kartu Grafis (WebGL)
                        try {
                            const getParameter = WebGLRenderingContext.prototype.getParameter;
                            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                                if (parameter === 37445) return opts.vendor; // UNMASKED_VENDOR_WEBGL
                                if (parameter === 37446) return opts.renderer; // UNMASKED_RENDERER_WEBGL
                                return getParameter.apply(this, arguments);
                            };
                        } catch(e) {}
                    }, { platform: platformStr, osName: osName, osVersion: osVersion, isMobile: isMobileProfile, ua: deviceProfile.userAgent, cores, memory, vendor, renderer });

                    await context.clearCookies().catch(() => { });
                    try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch (e) { }

                    if (isAborted) throw new Error("Aborted");

                    if (checkWhoer) {
                        log(`[${botId}] 1. Mengecek Whoer.net... (Maks 30 detik)`);
                        // Tambahkan timeout spesifik 30 detik agar jika proxy mati, tidak stuck terlalu lama
                        await page.goto('https://whoer.net/', { timeout: 30000 });
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

                    if (useCookies && cookieFileContent) {
                        try {
                            log(`[${botId}] 🍪 Mengunjungi YouTube untuk Bypass Login... (Maks 30 detik)`);
                            // Timeout 30 detik agar jika proxy mati tidak stuck
                            await page.goto('https://www.youtube.com/', { timeout: 30000 });
                            await page.waitForTimeout(2000);
                            const cookieStr = cookieFileContent;
                            let rawCookies = [];
                            if (cookieStr.trim().startsWith('{')) {
                                const parsed = JSON.parse(cookieStr);
                                if (parsed.cookies && Array.isArray(parsed.cookies)) {
                                    rawCookies = parsed.cookies;
                                } else {
                                    // Format Multi-Akun Object: { "akun1": [...], "akun2": [...] }
                                    const keys = Object.keys(parsed).filter(k => Array.isArray(parsed[k]));
                                    if (keys.length > 0) {
                                        const randomKey = keys[Math.floor(Math.random() * keys.length)];
                                        rawCookies = parsed[randomKey];
                                        log(`[${botId}] 🔀 Memilih random akun (Multi-Account JSON): ${randomKey}`);
                                    }
                                }
                            } else if (cookieStr.trim().startsWith('[')) {
                                const parsed = JSON.parse(cookieStr);
                                if (parsed.length > 0 && Array.isArray(parsed[0])) {
                                    // Format Multi-Akun Array of Arrays: [ [...akun1...], [...akun2...] ]
                                    const randomIdx = Math.floor(Math.random() * parsed.length);
                                    rawCookies = parsed[randomIdx];
                                    log(`[${botId}] 🔀 Memilih random akun dari Multi-Account JSON (Urutan ke-${randomIdx + 1})`);
                                } else {
                                    // Format Single-Account
                                    rawCookies = parsed;
                                }
                            } else if (cookieStr.includes('Netscape HTTP Cookie File') || cookieStr.includes('\t')) {
                                const lines = cookieStr.split('\n');
                                lines.forEach(line => {
                                    if (line.trim() === '' || line.startsWith('#')) return;
                                    const parts = line.split('\t');
                                    if (parts.length >= 7) {
                                        rawCookies.push({
                                            domain: parts[0],
                                            path: parts[2],
                                            secure: parts[3] === 'TRUE',
                                            expires: parseInt(parts[4]),
                                            name: parts[5],
                                            value: parts[6].trim()
                                        });
                                    }
                                });
                            }
                            
                            let cookiesArr = [];
                            if (rawCookies.length > 0) {
                                // Sanitasi ketat hanya ambil properti yang didukung Playwright
                                cookiesArr = rawCookies.map(c => {
                                    let domain = c.domain;
                                    
                                    const cleanCookie = {
                                        name: c.name,
                                        value: c.value,
                                        domain: domain,
                                        path: c.path || '/',
                                        expires: c.expires ? Math.floor(c.expires) : -1,
                                        httpOnly: Boolean(c.httpOnly),
                                        secure: Boolean(c.secure)
                                    };
                                    
                                    if (c.sameSite && typeof c.sameSite === 'string') {
                                        const ss = c.sameSite.toLowerCase();
                                        if (ss === 'lax') cleanCookie.sameSite = 'Lax';
                                        else if (ss === 'strict') cleanCookie.sameSite = 'Strict';
                                        else if (ss === 'none' || ss === 'no_restriction') cleanCookie.sameSite = 'None';
                                    }
                                    
                                    return cleanCookie;
                                });
                                await context.addCookies(cookiesArr).catch(e => {
                                    log(`[${botId}] ⚠️ Error set cookie format: ${e.message}`);
                                });
                                await page.reload({ timeout: 30000 }).catch(() => {});
                                await page.waitForTimeout(3000);
                                log(`[${botId}] 🍪 Berhasil memuat ${cookiesArr.length} cookies dari file (Bypass Login).`);
                                
                                // Cek status login dengan melihat elemen Avatar / Profile Picture di pojok kanan atas
                                const isLoggedIn = await page.evaluate(() => {
                                    // Berbagai selector avatar login di YouTube Desktop/Mobile/Music
                                    const avatar = document.querySelector('#avatar-btn, ytd-topbar-menu-button-renderer img, .ytm-profile-icon, ytmusic-profile-icon');
                                    // Selain itu, pastikan tombol "Sign in" raksasa tidak ada
                                    const signInBtn = document.querySelector('a[href^="https://accounts.google.com/ServiceLogin"]');
                                    return !!avatar && !signInBtn;
                                });

                                if (isLoggedIn) {
                                    log(`<span class="text-green-400 font-bold">[${botId}] 👤 VERIFIED: Berhasil Login ke Akun YouTube!</span>`);
                                } else {
                                    log(`<span class="text-yellow-400 font-bold">[${botId}] ⚠️ WARNING: Cookies dimuat, namun Akun Gagal Login (Sesi kadaluarsa / IP Terdeteksi).</span>`);
                                }

                            } else {
                                log(`[${botId}] ⚠️ File cookie kosong atau format tidak didukung.`);
                            }
                        } catch (err) {
                            log(`[${botId}] ⚠️ Gagal memuat cookie (Proxy Timeout / Error): ${err.message}`);
                        }
                    }

                    if (recoUrl && recoUrl.trim() !== '') {
                        log(`[${botId}] 2. Membuka Pancingan...`);
                        await page.goto(recoUrl);
                        await autoPlay(page, botId, log);
                        log(`[${botId}] Nonton Pancingan: ${recoDuration} detik...`);
                        await waitDuration(page, recoDuration * 1000, botId, log, config);
                    }

                    log(`[${botId}] 3. Membuka Target Utama...`);
                    if (trafficSource === 'search') {
                        log(`[${botId}] 🔎 Mencari kata kunci: "${searchKeyword}"`);
                        const searchUrl = isMusic 
                            ? `https://music.youtube.com/search?q=${encodeURIComponent(searchKeyword)}` 
                            : `https://www.youtube.com/results?search_query=${encodeURIComponent(searchKeyword)}`;
                        await page.goto(searchUrl);
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
                    } else if (trafficSource === 'external') {
                        log(`[${botId}] 🌐 Membuka link external: ${externalUrl}`);
                        await page.goto(externalUrl);
                        await page.waitForLoadState('domcontentloaded').catch(() => { });
                        
                        log(`[${botId}] ⏳ Menunggu pengalihan (redirect) ke target...`);
                        let waitRedirect = 0;
                        while(waitRedirect < 20000 && !isAborted) {
                            if(page.url().includes(isMusic ? 'music.youtube.com' : 'youtube.com')) {
                                break;
                            }
                            await page.waitForTimeout(1000).catch(() => {});
                            waitRedirect += 1000;
                        }
                    } else {
                        // Modify URL if platform doesn't match
                        let finalVideoUrl = videoUrl;
                        if (isMusic && finalVideoUrl.includes('www.youtube.com')) {
                            finalVideoUrl = finalVideoUrl.replace('www.youtube.com', 'music.youtube.com');
                        } else if (!isMusic && finalVideoUrl.includes('music.youtube.com')) {
                            finalVideoUrl = finalVideoUrl.replace('music.youtube.com', 'www.youtube.com');
                        }
                        await page.goto(finalVideoUrl);
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
                    await waitDuration(page, currentWatchDuration * 1000, botId, log, config);
                    if (onVideoSuccess) onVideoSuccess();

                    log(`[${botId}] 4. Membuka Video Random Lainnya...`);
                    if (randomVideoUrl && randomVideoUrl.trim() !== '') {
                        await page.goto(randomVideoUrl);
                        await page.waitForLoadState('domcontentloaded').catch(() => { });
                        await autoPlay(page, botId, log);
                        log(`[${botId}] Menonton video random selama 60 detik...`);
                        await waitDuration(page, 60000, botId, log, config);
                    } else {
                        const clickedRelated = await page.evaluate((isMusicMode) => {
                            let thumbs = [];
                            if (isMusicMode) {
                                thumbs = Array.from(document.querySelectorAll('ytmusic-two-row-item-renderer a, ytmusic-responsive-list-item-renderer a, a.yt-simple-endpoint.style-scope.ytmusic-player-queue-item'));
                            } else {
                                thumbs = Array.from(document.querySelectorAll('a#thumbnail, a.ytm-compact-video-renderer, ytd-compact-video-renderer a, a.compact-media-item-image'));
                            }
                            const validThumbs = thumbs.filter(t => t.href && t.href.includes('/watch'));
                            if (validThumbs.length > 0) {
                                const rnd = validThumbs[Math.floor(Math.random() * validThumbs.length)];
                                rnd.click();
                                return true;
                            }
                            return false;
                        }, isMusic);
                        if (clickedRelated) {
                            await page.waitForLoadState('domcontentloaded').catch(() => { });
                            await autoPlay(page, botId, log);
                            log(`[${botId}] Menonton video terkait selama 60 detik...`);
                            await waitDuration(page, 60000, botId, log, config);
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
            
            const workers = Array.from({ length: browserCount }).map(async (_, wIdx) => {
                let localLoop = 0;
                while (localLoop < maxLoop && !isAborted) {
                    if (localLoop > 0 && wIdx === 0) {
                        log(`<span class="text-purple-400 font-bold">🔄 [Proxy ${i+1}] LOOPING AKTIF: Putaran ke-${localLoop+1}</span>`);
                    }
                    const delayIdx = localLoop === 0 ? wIdx : 0;
                    await runSingleBot(currentProxy, i, wIdx + 1, delayIdx);
                    localLoop++;
                }
            });
            await Promise.allSettled(workers);
        }
    } else {
        let globalTaskIndex = 0;
        let currentLoopTrack = 0;
        
        const workers = Array.from({ length: browserCount }).map(async (_, wIdx) => {
            let firstRun = true;
            while (!isAborted) {
                const currentLoopNum = Math.floor(globalTaskIndex / proxyQueue.length);
                if (maxLoop !== Infinity && currentLoopNum >= maxLoop) {
                    break;
                }
                
                if (currentLoopNum > currentLoopTrack && wIdx === 0) {
                    currentLoopTrack = currentLoopNum;
                    log(`<br><span class="text-purple-400 font-bold">🔄 LOOPING AKTIF: Memulai putaran ke-${currentLoopNum + 1}${maxLoop === Infinity ? ' (Unlimited)' : ' dari ' + maxLoop}.</span><br>`);
                }
                
                const proxyIdx = globalTaskIndex % proxyQueue.length;
                const taskIdx = globalTaskIndex;
                globalTaskIndex++; // Ambil tiket antrean
                
                const currentProxy = proxyQueue[proxyIdx];
                const delayIdx = firstRun ? wIdx : 0;
                firstRun = false;
                
                await runSingleBot(currentProxy, taskIdx, wIdx + 1, delayIdx);
            }
        });
        await Promise.allSettled(workers);
    }

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
