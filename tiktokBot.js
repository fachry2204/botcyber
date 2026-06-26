import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { activeBots, proxySuccess, proxyFailed } from './bot.js';

let currentBrowser = null;
let isAborted = false;

export async function stopTikTokBot() {
    isAborted = true; 
    if (currentBrowser) {
        Promise.race([
            currentBrowser.close().catch(() => {}),
            new Promise(r => setTimeout(r, 2000))
        ]).then(() => {
            currentBrowser = null;
        });
    }
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

function getAccounts(accountInput) {
    if (!accountInput || accountInput.trim() === '') return [];
    return accountInput.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && line.includes(':'))
        .map(line => {
            const parts = line.split(':');
            return { username: parts[0], password: parts[1] };
        });
}

export async function runTikTokBot(config, callbacks) {
    isAborted = false;
    const { log, onSuccess, onFailed } = callbacks;
    const { ttMode, ttLiveUrl, ttLike, ttShare, ttTap, ttTapCount, ttFilePath, ttSong, ttCaption, accountFile, proxyFile, headless, browserCount, ttUserAgentMode } = config;

    let allProxies = getProxies(proxyFile);
    let accounts = getAccounts(accountFile);
    let currentAccountIndex = 0;
    let proxyQueue = allProxies.filter(p => !proxySuccess.has(p.server) && !proxyFailed.has(p.server));

    if (proxyQueue.length === 0) {
        log(`<span class="text-yellow-400 font-bold">⚠️ Antrean Kosong: Semua proxy terpakai.</span>`);
        return;
    }

    log(`🚀 Meluncurkan Engine Browser TikTok... (Mode: ${headless ? 'Siluman' : 'Terlihat'})`);
    
    const browserArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
    ];

    try {
        currentBrowser = await chromium.launch({ 
            headless,
            channel: 'chrome',
            args: browserArgs
        });
    } catch (e) {
        currentBrowser = await chromium.launch({ 
            headless,
            args: browserArgs
        });
    }

    if (isAborted) return;

    for (let i = 0; i < proxyQueue.length; i++) {
        if (isAborted) break;

        const proxyConfig = proxyQueue[i];
        let batchSuccess = true;

        log(`<br><span class="text-pink-400 font-bold">=================================================</span>`);
        log(`<span class="text-pink-400 font-bold">🔄 BATCH TIKTOK | PROXY: ${proxyConfig.server}</span>`);
        log(`<span class="text-pink-400 font-bold">=================================================</span><br>`);

        const promises = Array.from({ length: browserCount }).map(async (_, index) => {
            if (isAborted) return;
            const botId = `TTBot-${index + 1}`;
            let context = null;
            let page = null;
            let account = null;
            let sessionPath = null;

            const tabDelayMs = (config.tabDelay || 5) * 1000;
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
                let contextOptions = { ignoreHTTPSErrors: true };
                
                let deviceProfile = 'Pixel 5';
                if (ttUserAgentMode === 'desktop') {
                    deviceProfile = 'Desktop Chrome';
                }
                contextOptions = { ...contextOptions, ...devices[deviceProfile] };
                
                if (proxyConfig.server !== 'DIRECT (Tanpa Proxy)') contextOptions.proxy = proxyConfig;

                if (accounts.length > 0) {
                    account = accounts[currentAccountIndex % accounts.length];
                    currentAccountIndex++;
                    
                    const sessionDir = path.join(process.cwd(), 'sessions', 'tiktok');
                    if (!fs.existsSync(sessionDir)) {
                        fs.mkdirSync(sessionDir, { recursive: true });
                    }
                    sessionPath = path.join(sessionDir, `session_${account.username.replace(/[^a-z0-9]/gi, '_')}.json`);
                    if (fs.existsSync(sessionPath)) {
                        contextOptions.storageState = sessionPath;
                        log(`[${botId}] 🗂️ Memuat session yang tersimpan untuk ${account.username}`);
                    }
                }

                if (ttMode !== 'phonefarm') {
                    context = await currentBrowser.newContext(contextOptions);
                    page = await context.newPage();
                    page.setDefaultTimeout(60000);
                    
                    activeBots.set(botId, {
                        context,
                        page,
                        proxy: proxyConfig.server,
                        device: 'Pixel 5',
                        startTime: Date.now()
                    });
                } else {
                    activeBots.set(botId, {
                        context: null,
                        page: null,
                        proxy: 'ADB',
                        device: 'Phonefarm',
                        startTime: Date.now()
                    });
                }
                
                // Jika ada akun dan bukan mode phonefarm, coba login web dulu
                if (account && ttMode !== 'phonefarm') {
                    // Navigasi langsung ke tujuan akhir (Upload atau Live)
                    const targetUrl = (ttMode === 'upload') ? 'https://www.tiktok.com/creator-center/upload' : ttLiveUrl;
                    log(`[${botId}] 🌐 Membuka halaman target: ${ttMode === 'upload' ? 'Upload Konten' : 'Live Stream'}`);
                    await page.goto(targetUrl);
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForTimeout(3000); // Tunggu proses redirect otomatis TikTok
                    
                    const currentUrl = page.url();
                    const isLoggedIn = !currentUrl.includes('/login');

                    if (!isLoggedIn) {
                        log(`[${botId}] 🔐 Belum login. Memulai proses pengisian form login untuk: ${account.username}`);
                        
                        // Karena kita diarahkan ke halaman login utama, klik opsi 'Use phone / email / username'
                        const usePhoneEmailBtn = page.locator('a[href*="/login/phone-or-email"], div:has-text("Use phone / email / username"), p:has-text("Use phone / email / username")').first();
                        if (await usePhoneEmailBtn.isVisible({timeout: 5000})) {
                            await usePhoneEmailBtn.click();
                            await page.waitForTimeout(2000);
                        } else {
                            // Fallback jika tombol tidak ketemu, pergi ke URL email secara manual
                            await page.goto('https://www.tiktok.com/login/phone-or-email/email');
                            await page.waitForLoadState('domcontentloaded');
                        }
                        
                        try {
                            // Pastikan tab 'Email/Username' aktif (kadang default ke Phone)
                            const emailTab = page.locator('a:has-text("Log in with email or username"), a:has-text("Email or username"), a:has-text("Log in with email")').first();
                            if (await emailTab.isVisible({timeout: 3000}).catch(()=>false)) {
                                await emailTab.click();
                                await page.waitForTimeout(1000);
                            }

                            const userField = page.locator('input[name="username"], input[type="text"][placeholder*="Email"], input[type="text"][placeholder*="username"]').first();
                            const finalUserField = (await userField.isVisible({timeout: 2000})) ? userField : page.locator('input[type="text"]').first();
                            
                            const passField = page.locator('input[type="password"]').first();
                            const loginBtn = page.locator('button[type="submit"], button:has-text("Log in")').first();
                            
                            if (await passField.isVisible({timeout: 10000})) {
                                await finalUserField.fill(account.username);
                                await page.waitForTimeout(1000);
                                await passField.fill(account.password);
                                await page.waitForTimeout(1000);
                                await loginBtn.click();
                                log(`[${botId}] ⏳ Proses submit login...`);
                                
                                await page.waitForTimeout(8000);
                                
                                const captcha = page.locator('#captcha-verify-image');
                                if (await captcha.isVisible({timeout: 3000}).catch(()=>false)) {
                                    log(`[${botId}] ⚠️ Captcha muncul! Harap selesaikan captcha secara manual di layar.`);
                                    await page.waitForTimeout(30000);
                                }
                                // Simpan state setelah manual login (jika berhasil)
                                if (sessionPath) {
                                    await context.storageState({ path: sessionPath });
                                    log(`[${botId}] 💾 Session login berhasil disimpan.`);
                                }
                                
                                // Tunggu sebentar agar TikTok memproses login dan redirect kembali ke halaman target
                                log(`[${botId}] ⏳ Menunggu redirect otomatis ke halaman target...`);
                                await page.waitForTimeout(5000);
                                if (page.url().includes('/login')) {
                                    // Jika masih nyangkut di login page, paksa ke target
                                    await page.goto(targetUrl);
                                }
                            } else {
                                log(`[${botId}] ⚠️ Form login tidak ditemukan, mungkin sudah login atau layout berubah.`);
                            }
                        } catch(e) {
                            log(`[${botId}] ⚠️ Gagal otomatisasi login: ${e.message}`);
                        }
                    } else {
                        log(`[${botId}] ✅ Akun ${account.username} sudah dalam keadaan login (Cache aktif).`);
                    }
                }

                if (ttMode === 'live') {
                    // Skip goto here since we already navigated to the target URL at the start!
                    log(`[${botId}] 📺 Memproses tugas TikTok Live...`);
                    
                    // Simple interaction sequence
                    if (ttLike) {
                        log(`[${botId}] ❤️ Auto Like Video...`);
                        const likeBtn = page.locator('button[data-e2e="like-button"], .like-button').first();
                        if (await likeBtn.isVisible().catch(()=>false)) {
                            await likeBtn.click().catch(()=>{});
                        }
                    }
                    
                    if (ttShare) {
                        log(`[${botId}] 🔗 Auto Share (Copy Link)...`);
                        const shareBtn = page.locator('button[data-e2e="share-button"], .share-button').first();
                        if (await shareBtn.isVisible().catch(()=>false)) {
                            await shareBtn.click().catch(()=>{});
                            await page.waitForTimeout(1000);
                            const copyBtn = page.locator('span:has-text("Copy link")').first();
                            if (await copyBtn.isVisible().catch(()=>false)) {
                                await copyBtn.click().catch(()=>{});
                            }
                        }
                    }
                    
                    if (ttTap) {
                        log(`[${botId}] 👆 Memulai ${ttTapCount} Tap Layar...`);
                        for (let t = 0; t < ttTapCount; t++) {
                            if (isAborted) break;
                            await page.mouse.click(200, 300).catch(()=>{});
                            await page.waitForTimeout(200).catch(()=>{});
                            if (t % 10 === 0 && t > 0) log(`[${botId}] Sudah tap layar ${t} kali...`);
                        }
                    }
                    
                    log(`[${botId}] ✅ Tugas Live selesai. Menonton live sejenak...`);
                    await page.waitForTimeout(30000).catch(()=>{});
                } 
                else if (ttMode === 'upload') {
                    log(`[${botId}] 📤 Memproses halaman Upload TikTok...`);
                    // Skip goto here since we already navigated to the target URL at the start!
                    
                    if (!account) {
                        log(`[${botId}] ⚠️ Anda tidak memasukkan daftar akun. Harap login manual di jendela browser yang terbuka.`);
                    } else {
                        log(`[${botId}] ⏳ Sedang bersiap mengunggah file... (Selesaikan Captcha jika masih ada)`);
                    }
                    
                    // Tunggu selector input file upload (sebagai tanda siap upload)
                    await page.waitForSelector('input[type="file"], input[accept="video/*"]', { timeout: 120000 }).catch(()=>{});
                    
                    if (ttFilePath) {
                        log(`[${botId}] 📁 Mengunggah file: ${ttFilePath}`);
                        const fileInput = page.locator('input[type="file"], input[accept="video/*"]').first();
                        if (await fileInput.isVisible().catch(()=>false)) {
                            await fileInput.setInputFiles(ttFilePath);
                        } else {
                            throw new Error("Input upload tidak ditemukan. Mungkin belum login?");
                        }
                    }

                    await page.waitForTimeout(5000).catch(()=>{});
                    
                    if (ttCaption) {
                        log(`[${botId}] 📝 Menulis caption...`);
                        // Tik Tok editor usually uses div.public-DraftEditor-content
                        const editor = page.locator('.public-DraftEditor-content').first();
                        if (await editor.isVisible().catch(()=>false)) {
                            await editor.click();
                            await page.keyboard.type(ttCaption, { delay: 50 });
                        }
                    }

                    if (ttSong) {
                        log(`[${botId}] 🎵 Mencari dan menambahkan lagu: ${ttSong}`);
                        try {
                            // Coba klik tombol "Edit video" atau "Add Sound" (Lokator bisa berubah sesuai update TikTok Web)
                            const addSoundBtn = page.locator('div:has-text("Edit video"), button:has-text("Add sound")').last();
                            if (await addSoundBtn.isVisible({timeout: 5000})) {
                                await addSoundBtn.click();
                                await page.waitForTimeout(2000);
                                
                                const searchInput = page.locator('input[placeholder*="Search"], input[type="text"]').last();
                                if (await searchInput.isVisible()) {
                                    await searchInput.fill(ttSong);
                                    await page.keyboard.press('Enter');
                                    await page.waitForTimeout(3000);
                                    
                                    // Klik tombol 'Use' pada hasil pencarian pertama
                                    const useBtn = page.locator('button:has-text("Use")').first();
                                    if (await useBtn.isVisible()) {
                                        await useBtn.click();
                                        log(`[${botId}] ✅ Lagu "${ttSong}" berhasil ditambahkan.`);
                                    }
                                }
                            } else {
                                log(`[${botId}] ⚠️ Tombol tambah lagu tidak ditemukan di antarmuka web saat ini.`);
                            }
                        } catch(e) {
                            log(`[${botId}] ⚠️ Gagal menambahkan lagu otomatis: ${e.message}`);
                        }
                    }
                    
                    log(`[${botId}] ✅ Silakan lanjutkan proses upload / edit secara manual jika diperlukan.`);
                    // Tunggu sebelum auto close
                    await page.waitForTimeout(60000).catch(()=>{});
                } else if (ttMode === 'phonefarm') {
                    const { ttPfDeviceId, ttPfFilePath, ttPfSong, ttPfCaption } = config;
                    log(`[${botId}] 📱 Mode Phonefarm (ADB) diaktifkan.`);
                    
                    const util = await import('util');
                    const exec = util.promisify((await import('child_process')).exec);
                    
                    // Gunakan spesifik device jika ada
                    const deviceFlag = ttPfDeviceId ? `-s ${ttPfDeviceId}` : '';
                    
                    try {
                        log(`[${botId}] 🔌 Memeriksa koneksi ADB...`);
                        await exec(`adb ${deviceFlag} get-state`);
                        
                        log(`[${botId}] 🚀 Membuka aplikasi TikTok di HP...`);
                        // Daftar package name TikTok (Asia/Indonesia, Global, Lite)
                        const ttPackages = ['com.ss.android.ugc.trill', 'com.zhiliaoapp.musically', 'com.zhiliaoapp.musically.go'];
                        let appLaunched = false;
                        
                        for (const pkg of ttPackages) {
                            try {
                                await exec(`adb ${deviceFlag} shell am force-stop ${pkg}`).catch(()=>{});
                                await exec(`adb ${deviceFlag} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
                                appLaunched = true;
                                log(`[${botId}] ✅ Berhasil membuka TikTok (${pkg})`);
                                break;
                            } catch(e) {
                                // Lanjut coba package name berikutnya
                            }
                        }
                        
                        if (!appLaunched) {
                            throw new Error('Aplikasi TikTok tidak ditemukan di HP Anda. Pastikan TikTok (Ori/Lite) sudah terinstall.');
                        }
                        
                        log(`[${botId}] 🪞 Membuka SCRCPY untuk Mirroring Layar...`);
                        // Jalankan scrcpy di background tanpa di-await agar tidak memblokir proses bot
                        exec(`scrcpy ${deviceFlag}`).catch(() => log(`[${botId}] ℹ️ Scrcpy tidak ditemukan/gagal dibuka. Pastikan scrcpy terinstall di Path Windows Anda.`));
                        
                        log(`[${botId}] ⏳ Menunggu 45 detik agar TikTok terbuka sempurna...`);
                        await new Promise(r => setTimeout(r, 45000)); // Tunggu aplikasi terbuka
                        
                        if (ttPfFilePath) {
                            log(`[${botId}] 📁 Mendorong file media ke HP...`);
                            const fileName = ttPfFilePath.split('\\').pop().split('/').pop();
                            await exec(`adb ${deviceFlag} push "${ttPfFilePath}" /sdcard/DCIM/Camera/${fileName}`);
                            log(`[${botId}] ✅ File berhasil masuk ke /sdcard/DCIM/Camera/${fileName}`);
                            
                            // Scan media agar muncul di gallery HP
                            await exec(`adb ${deviceFlag} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/DCIM/Camera/${fileName}`);
                        }

                        log(`[${botId}] 📝 Menyiapkan Text Caption & Song: ${ttPfCaption || ''} | ${ttPfSong || ''}`);
                        
                        log(`[${botId}] 🤖 Memulai otomatisasi makro UI TikTok (BETA)...`);
                        // Ambil resolusi layar HP
                        const sizeOutput = await exec(`adb ${deviceFlag} shell wm size`).catch(() => ({ stdout: 'Physical size: 720x1280' }));
                        const match = sizeOutput.stdout.match(/(\d+)x(\d+)/);
                        let w = 720, h = 1280;
                        if (match) {
                            w = parseInt(match[1]);
                            h = parseInt(match[2]);
                        }
                        log(`[${botId}] 📏 Resolusi terdeteksi: ${w}x${h}`);

                        const tap = async (px, py, desc, delay = 2000) => {
                            const x = Math.floor(w * px);
                            const y = Math.floor(h * py);
                            log(`[${botId}] 👆 Tap ${desc}`);
                            await exec(`adb ${deviceFlag} shell input tap ${x} ${y}`).catch(()=>{});
                            await new Promise(r => setTimeout(r, delay));
                        };

                        // 1. Pastikan berada di Home (Kiri Bawah)
                        await tap(0.1, 0.95, "Tab Home", 3000);

                        // 2. Klik Tombol Plus (Tengah Bawah)
                        await tap(0.5, 0.96, "Tombol Plus (+)", 6000);

                        // 3. Klik Upload/Gallery (Kanan Bawah dari layar kamera)
                        await tap(0.8, 0.85, "Tombol Upload Gallery", 5000);

                        // 4. Pilih Media Pertama (Kiri Atas Grid)
                        await tap(0.2, 0.25, "File Media Pertama", 2000);

                        // 5. Klik Next di Gallery (Kanan Bawah)
                        // Butuh waktu agak lama untuk memuat halaman editor jika video panjang
                        await tap(0.8, 0.95, "Tombol Next (Gallery)", 8000);

                        // 6. Klik Next di Video Editor (Kanan Bawah)
                        await tap(0.85, 0.95, "Tombol Next (Editor)", 8000);

                        // 7. Ketik Caption
                        if (ttPfCaption) {
                            log(`[${botId}] ⌨️ Mengetik Caption...`);
                            await tap(0.3, 0.2, "Kolom Caption", 4000);
                            
                            // Hapus spasi diganti %s agar adb input text tidak error
                            const safeCaption = ttPfCaption.replace(/\s+/g, '%s').replace(/"/g, '\\"');
                            await exec(`adb ${deviceFlag} shell input text "${safeCaption}"`).catch(()=>{});
                            await new Promise(r => setTimeout(r, 3000));
                            
                            // Tap di area netral untuk menutup keyboard
                            await tap(0.1, 0.5, "Area Netral (Tutup Keyboard)", 2000);
                        }

                        // 8. Posting
                        await tap(0.8, 0.96, "Tombol Post", 5000);
                        log(`[${botId}] ✅ Otomatisasi Makro Selesai! Jika ada pop-up tak terduga, silakan perbaiki manual via Scrcpy.`);

                        // Biarkan sesi phonefarm hidup agar user bisa mengontrol lewat scrcpy jika makro meleset
                        let waited = 0;
                        while (waited < 600000 && !isAborted) {
                            await new Promise(r => setTimeout(r, 2000));
                            waited += 2000;
                        }
                    } catch (adbErr) {
                        throw new Error(`Koneksi ADB Gagal. Pastikan HP terhubung, USB Debugging aktif, dan ADB terinstall di Windows. Error: ${adbErr.message}`);
                    }
                }

            } catch (err) {
                if (err.message !== "Aborted") {
                    log(`<span class="text-red-400">[${botId}] Error: ${err.message}</span>`);
                    batchSuccess = false;
                }
            } finally {
                activeBots.delete(botId);
                if (context) {
                    if (sessionPath) {
                        await context.storageState({ path: sessionPath }).catch(()=>{});
                    }
                    await context.close().catch(()=>{});
                }
            }
        });

        await Promise.all(promises);

        if (isAborted) break;

        if (batchSuccess) {
            proxySuccess.add(proxyConfig.server);
            onSuccess(proxyConfig.server);
        } else {
            proxyFailed.add(proxyConfig.server);
            onFailed(proxyConfig.server, "Gagal/Error saat TikTok bot berjalan");
        }
    }

    log("<br>🎉 Operasi TikTok Bot selesai.");
    if (currentBrowser) {
        await currentBrowser.close().catch(() => {});
        currentBrowser = null;
    }
}
