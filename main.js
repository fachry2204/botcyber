import { app, BrowserWindow, ipcMain } from 'electron';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true, // Sembunyikan menu bar seperti browser biasa
    title: "BotCyber - Desktop App",
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Load UI dari port dinamis server
  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// Ketika web contents baru dibuat (jendela utama atau jendela popup)
app.on('web-contents-created', (event, contents) => {
  // Izinkan pop-up / window baru dengan konfigurasi yang sama
  contents.setWindowOpenHandler(({ url }) => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: true
        }
      }
    };
  });

  // Inject script untuk mengubah semua link menu menjadi pop-up window baru
  contents.on('dom-ready', () => {
    contents.executeJavaScript(`
      document.querySelectorAll('nav a').forEach(a => {
        if(a.href && !a.href.endsWith('#')) {
            a.setAttribute('target', '_blank');
        }
      });
    `);
  });
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Jika user mencoba buka app lagi, fokuskan ke app yang sudah ada
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', () => {
    console.log("Memulai Server Bot di latar belakang...");
    // Jalankan server.js secara otomatis di background
  serverProcess = fork(path.join(__dirname, 'server.js'));
  
  // Terima request update dari Express Backend (server.js)
  serverProcess.on('message', (msg) => {
    if (msg.type === 'check-update') {
      autoUpdater.checkForUpdates().catch(err => {
        if(serverProcess) serverProcess.send({ type: 'update-status', status: 'error', message: err.message });
      });
    } else if (msg.type === 'download-update') {
      autoUpdater.downloadUpdate().catch(e => console.error(e));
    } else if (msg.type === 'install-update') {
      autoUpdater.quitAndInstall(false, true);
    } else if (msg.type === 'server-ready') {
      createWindow(msg.port);
    }
  });
});

// Ketika window / aplikasi ditutup
app.on('window-all-closed', function () {
  app.quit();
});

// Pastikan proses Node (server.js) juga mati ketika aplikasi ditutup
app.on('quit', () => {
  if (serverProcess) {
    try { 
      serverProcess.send({ type: 'shutdown' }); 
      // Paksa bunuh setelah 500ms jika masih membandel
      setTimeout(() => {
        try { serverProcess.kill('SIGKILL'); } catch (e) {}
      }, 500);
    } catch (e) {
      try { serverProcess.kill('SIGKILL'); } catch (err) {}
    }
  }
});

// ==========================================
// OTA (Over The Air) UPDATE SYSTEM
// ==========================================
// Mencegah auto-download agar user bisa melihat tombol "Update" terlebih dahulu
autoUpdater.autoDownload = false;

// Terima request dari frontend (lewat Socket.IO -> IPC, atau preload)
// Tapi karena kita menggunakan express, frontend akan berkomunikasi lewat API ke server.js, 
// kemudian server.js tidak bisa langsung memanggil autoUpdater jika tidak berada di proses yang sama.
// SOLUSI: server.js akan di-fork. 
// Lebih baik OTA dicek saat aplikasi dibuka dan kita expose API update status ke frontend.

// Pengecekan update
ipcMain.on('check-update', () => {
  autoUpdater.checkForUpdates().catch(err => {
    if(serverProcess) serverProcess.send({ type: 'update-status', status: 'error', message: err.message });
  });
});

// Download update
ipcMain.on('download-update', () => {
  autoUpdater.downloadUpdate();
});

// Install update & Restart
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Event Listeners autoUpdater
autoUpdater.on('update-available', (info) => {
  if(serverProcess) serverProcess.send({ type: 'update-status', status: 'available', version: info.version });
});

autoUpdater.on('update-not-available', (info) => {
  if(serverProcess) serverProcess.send({ type: 'update-status', status: 'not-available' });
});

autoUpdater.on('download-progress', (progressObj) => {
  if(serverProcess) serverProcess.send({ type: 'update-status', status: 'progress', percent: progressObj.percent });
});

autoUpdater.on('update-downloaded', (info) => {
  if(serverProcess) serverProcess.send({ type: 'update-status', status: 'downloaded' });
});

autoUpdater.on('error', (err) => {
  if(serverProcess) serverProcess.send({ type: 'update-status', status: 'error', message: err.message });
});
}
