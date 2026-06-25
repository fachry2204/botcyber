@echo off
title BotCyber
color 0A

echo =========================================
echo       MEMULAI BOTCYBER...
echo =========================================
echo.
echo 1. Menjalankan Server (npm run dev)...
start "Server BotCyber" cmd /c "npm run dev"

echo 2. Menunggu server siap (4 detik)...
timeout /t 4 /nobreak >nul

echo 3. Membuka Dashboard di Browser...
start http://localhost:3000

echo.
echo Selesai! Anda bisa menutup jendela hitam ini.
echo (Biarkan jendela server yang satunya tetap terbuka selama bot berjalan)
timeout /t 3 >nul
exit
