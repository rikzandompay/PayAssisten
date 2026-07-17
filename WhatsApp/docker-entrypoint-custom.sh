#!/bin/sh
# Hapus SingletonLock yang ditinggalkan proses Chromium sebelumnya
# agar bot bisa restart dengan bersih tanpa error "browser already running"
find /app/.wwebjs_auth -name "SingletonLock" -delete 2>/dev/null || true
find /app/.wwebjs_auth -name "SingletonCookie" -delete 2>/dev/null || true
find /app/.wwebjs_auth -name "SingletonSocket" -delete 2>/dev/null || true

echo "[entrypoint] Lock files cleaned. Starting server..."
exec npm start
