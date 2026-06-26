import { chromium } from 'playwright';
import fs from 'fs';

// --- KONFIGURASI BOT ---
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Ganti dengan URL video tujuan
const PROXIES_FILE = './proxies.txt';
const HEADLESS = true; // Diubah ke true karena menjalankan ratusan browser secara terlihat akan membuat komputer hang
const WATCH_DURATION_MS = 60000; // Durasi menonton dalam milidetik (contoh: 60000 = 1 menit)

// Fungsi untuk membaca daftar proxy dari file
function getProxies() {
    if (!fs.existsSync(PROXIES_FILE)) {
        console.error(`File ${PROXIES_FILE} tidak ditemukan!`);
        return [];
    }
    
    const data = fs.readFileSync(PROXIES_FILE, 'utf8');
    const lines = data.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#')); // Abaikan baris kosong dan komentar
    
    return lines.map(line => {
        const parts = line.split(':');
        if (parts.length >= 4) {
            // Proxy dengan Autentikasi (IP:PORT:USER:PASS)
            return {
                server: `http://${parts[0]}:${parts[1]}`,
                username: parts[2],
                password: parts[3]
            };
        } else if (parts.length >= 2) {
            // Proxy Tanpa Autentikasi (IP:PORT)
            return {
                server: `http://${parts[0]}:${parts[1]}`
            };
        }
        return null;
    }).filter(p => p !== null);
}

async function runBot() {
    const proxies = getProxies();
    
    if (proxies.length === 0) {
        console.log("⚠️ Tidak ada proxy yang dimuat dari file proxies.txt.");
        console.log("🤖 Menjalankan 1 browser TANPA proxy sebagai contoh/testing...");
        proxies.push(undefined); // Tambah 1 bot tanpa proxy
    } else {
        console.log(`✅ Berhasil memuat ${proxies.length} proxy.`);
    }

    console.log("🚀 Meluncurkan browser utama...");
    // Meluncurkan 1 instance browser. Kita menggunakan 1 instance dan membuat banyak "Context" (profil/tab terisolasi).
    // Cara ini jauh lebih hemat RAM dibanding membuka puluhan window aplikasi browser.
    const browser = await chromium.launch({ headless: HEADLESS });

    // Membuat array dari Promises (menjalankan semua bot secara bersamaan/paralel)
    const promises = proxies.map(async (proxyConfig, index) => {
        const botId = `Bot-${index + 1}`;
        try {
            console.log(`[${botId}] ⏳ Menunggu jeda ${index * 5} detik sebelum memulai...`);
            await new Promise(resolve => setTimeout(resolve, index * 5000));

            console.log(`[${botId}] Memulai dengan proxy: ${proxyConfig ? proxyConfig.server : 'Tanpa Proxy'}`);
            
            // Membuat konteks browser yang terisolasi. Cookie, cache, proxy terpisah dari yang lain.
            const context = await browser.newContext({
                proxy: proxyConfig,
                // Opsi tambahan untuk menyamarkan bot bisa ditambahkan di sini, misalnya merandom User-Agent:
                // userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...'
            });

            // Membuka halaman/tab baru di dalam konteks tersebut
            const page = await context.newPage();
            
            // Mengatur timeout default agar tidak error jika internet agak lambat (60 detik)
            page.setDefaultTimeout(60000);

            console.log(`[${botId}] Menuju ke URL video...`);
            await page.goto(VIDEO_URL);

            console.log(`[${botId}] Berhasil memuat halaman video! Sedang 'menonton'...`);
            
            // Di sini Anda bisa menambahkan interaksi otomatis, 
            // contoh: auto-click tombol "Play" YouTube jika diperlukan:
            // await page.locator('.ytp-play-button').click().catch(() => {});

            // Menunggu selama durasi yang ditentukan (mensimulasikan nonton)
            await page.waitForTimeout(WATCH_DURATION_MS);
            
            console.log(`[${botId}] Selesai menonton selama ${WATCH_DURATION_MS / 1000} detik.`);
            
            // Tutup konteks setelah selesai untuk membersihkan memori
            await context.close();
            
        } catch (error) {
            console.error(`[${botId}] Terjadi error:`, error.message);
        }
    });

    // Menunggu semua proses bot selesai
    await Promise.all(promises);
    
    console.log("🎉 Semua sesi bot telah selesai. Menutup browser utama...");
    await browser.close();
}

// Menjalankan script
runBot().catch(console.error);
