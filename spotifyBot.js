import { chromium, devices } from 'playwright';
import fs from 'fs';
import UserAgent from 'user-agents';
import axios from 'axios';

let currentBrowser = null;
let isAborted = false;

// Global State
export const activeBots = new Map();

export async function stopSpotifyBot() {
    isAborted = true; 

    for (const [botId, bot] of activeBots.entries()) {
        if (bot.context) {
            bot.context.close().catch(() => {});
        }
    }
    activeBots.clear();

    if (currentBrowser) {
        Promise.race([
            currentBrowser.close().catch(() => {}),
            new Promise(r => setTimeout(r, 5000))
        ]).then(() => {
            currentBrowser = null;
        });
    }
}

function parseAccounts(data) {
    if (!data || data.trim() === '') return [];
    return data.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
            const parts = line.split(':');
            return { username: parts[0], password: parts[1] };
        });
}

export async function runSpotifyBot(config, callbacks) {
    isAborted = false;
    const { log, onSuccess, onFailed } = callbacks;
    const { accountFile, trafficSource, videoUrl, searchKeyword, searchVideoId, headless, browserCount, watchDurationMin, watchDurationMax, tabDelay } = config;
    const tabDelayMs = (tabDelay || 5) * 1000;

    const accounts = parseAccounts(accountFile);
    if (accounts.length === 0) {
        log(`<span class="text-yellow-400 font-bold">⚠️ Tidak ada akun Spotify yang diisi. Masukkan format username:password.</span>`);
        return;
    }

    log(`🚀 Meluncurkan Engine Browser (Spotify Mode)...`);
    
    const browserArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--autoplay-policy=no-user-gesture-required'
    ];

    try {
        currentBrowser = await chromium.launch({ headless, channel: 'chrome', args: browserArgs });
    } catch (e) {
        try {
            currentBrowser = await chromium.launch({ headless, args: browserArgs });
        } catch (err) {
            log(`<span class="text-red-400">Gagal meluncurkan browser: ${err.message}</span>`);
            return;
        }
    }

    if (isAborted) return;

    for (let i = 0; i < accounts.length; i += browserCount) {
        if (isAborted) break;

        const batchAccounts = accounts.slice(i, i + browserCount);
        
        log(`<br><span class="text-green-400 font-bold">=================================================</span>`);
        log(`<span class="text-green-400 font-bold">🔄 BATCH BARU | Membuka ${batchAccounts.length} Akun Serentak</span>`);
        log(`<span class="text-green-400 font-bold">=================================================</span><br>`);

        const promises = batchAccounts.map(async (account, index) => {
            if (isAborted) return;
            const botId = `Spotify-${i + index + 1}`;
            let context = null;

            log(`[${botId}] 🌐 Menyiapkan Akun: ${account.username}`);

            const delayMs = index * tabDelayMs;
            if (delayMs > 0) {
                log(`[${botId}] ⏳ Menunggu jeda ${(config.tabDelay || 5) * index} detik sebelum membuka tab...`);
                let waited = 0;
                while (waited < delayMs && !isAborted) {
                    await new Promise(r => setTimeout(r, Math.min(1000, delayMs - waited)));
                    waited += 1000;
                }
            }

            try {
                if (isAborted) throw new Error("Aborted");

                const deviceProfile = devices['Desktop Chrome'];
                context = await currentBrowser.newContext({
                    ...deviceProfile,
                    ignoreHTTPSErrors: true
                });

                const page = await context.newPage();
                page.setDefaultTimeout(60000);
                
                activeBots.set(botId, { context, page, proxy: 'Direct', device: 'Desktop Chrome', startTime: Date.now() });

                log(`[${botId}] 1. Login ke Spotify...`);
                await page.goto('https://accounts.spotify.com/en/login');
                await page.waitForTimeout(3000);
                
                // Cek field username (flow baru)
                const userField = await page.waitForSelector('input[data-testid="login-username"]', { timeout: 10000 }).catch(() => null);
                if (userField) {
                    await page.focus('input[data-testid="login-username"]');
                    await page.type('input[data-testid="login-username"]', account.username, { delay: 50 });
                    
                    const nextBtn = await page.waitForSelector('button[data-testid="login-button"]', { timeout: 5000 }).catch(() => null);
                    if (nextBtn) {
                        await page.waitForTimeout(1000);
                        await nextBtn.click();
                        await page.waitForTimeout(4000); // Tunggu form password muncul
                        
                        const passField = await page.waitForSelector('input[data-testid="login-password"]', { timeout: 5000 }).catch(() => null);
                        if (passField) {
                            await page.focus('input[data-testid="login-password"]');
                            await page.type('input[data-testid="login-password"]', account.password, { delay: 50 });
                            await page.waitForTimeout(1000);
                            await page.click('button[data-testid="login-button"]').catch(()=>{});
                        } else {
                            await page.fill('#login-password', account.password).catch(()=>{});
                            await page.click('#login-button').catch(()=>{});
                        }
                    }
                } else {
                    // Fallback form lama
                    await page.fill('#login-username', account.username).catch(()=>{});
                    await page.fill('#login-password', account.password).catch(()=>{});
                    await page.click('#login-button').catch(()=>{});
                }
                
                await page.waitForTimeout(5000); // Tunggu loading login

                if (trafficSource === 'search') {
                    log(`[${botId}] 2. Mencari lagu: ${searchKeyword}`);
                    await page.goto(`https://open.spotify.com/search/${encodeURIComponent(searchKeyword)}`);
                    await page.waitForTimeout(4000);

                    // Mencari Track ID di hasil pencarian
                    log(`[${botId}] Memutar Track ID: ${searchVideoId}`);
                    // Click track by ID or play button generic
                    const playButtonSelector = `button[data-testid="play-button"]`;
                    const btns = await page.$$(playButtonSelector);
                    if(btns.length > 0) {
                        await btns[0].click().catch(()=>{});
                        log(`[${botId}] 🟢 Mulai memutar...`);
                    } else {
                        log(`[${botId}] ⚠️ Tombol play tidak ditemukan.`);
                    }
                } else {
                    log(`[${botId}] 2. Buka URL langsung: ${videoUrl}`);
                    await page.goto(videoUrl);
                    await page.waitForTimeout(4000);

                    // Klik tombol play utama
                    await page.click('button[data-testid="play-button"]').catch(()=>{});
                    log(`[${botId}] 🟢 Mulai memutar URL target...`);
                }

                // Hitung durasi streaming
                let currentWatchDuration = watchDurationMin || 60;
                if (watchDurationMax > watchDurationMin) {
                    currentWatchDuration = Math.floor(Math.random() * (watchDurationMax - watchDurationMin + 1)) + watchDurationMin;
                }
                
                log(`[${botId}] 🎧 Streaming selama ${currentWatchDuration} detik...`);
                
                // Human scrolling/wait loop
                let elapsed = 0;
                while (elapsed < currentWatchDuration * 1000 && !isAborted) {
                    await page.waitForTimeout(2000);
                    elapsed += 2000;
                    if (elapsed % 15000 === 0 && !isAborted) {
                        await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300) - 100)).catch(()=>{});
                    }
                }

                if (isAborted) throw new Error("Aborted");

                log(`<span class="text-green-400 font-bold">✅ [${botId}] Selesai Streaming untuk akun ${account.username}.</span>`);
                onSuccess(account.username);

            } catch (error) {
                if (error.message === "Aborted" || error.message.includes('closed') || isAborted) {
                    log(`[${botId}] 🛑 Sesi dihentikan paksa.`);
                } else {
                    log(`<span class="text-red-400 font-bold">☠️ [${botId}] GAGAL: ${error.message}</span>`);
                    onFailed(account.username, error.message);
                }
            } finally {
                activeBots.delete(botId);
                if (context) {
                    await context.close().catch(() => {});
                }
            }
        });

        await Promise.all(promises);

        if (isAborted) {
            break;
        }
    }
    
    if (isAborted) {
        log("<br><span class='text-yellow-400 font-bold'>🛑 Operasi Spotify bot dihentikan.</span>");
    } else {
        log("<br>🎉 Antrean akun telah habis diproses. Engine ditutup.");
    }

    if (currentBrowser) {
        await currentBrowser.close().catch(() => {});
        currentBrowser = null;
    }
}
