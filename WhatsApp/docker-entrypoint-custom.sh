#!/bin/sh
# Hapus SingletonLock yang ditinggalkan proses Chromium sebelumnya
# agar bot bisa restart dengan bersih tanpa error "browser already running"
find /app/.wwebjs_auth -name "SingletonLock" -delete 2>/dev/null || true
find /app/.wwebjs_auth -name "SingletonCookie" -delete 2>/dev/null || true
find /app/.wwebjs_auth -name "SingletonSocket" -delete 2>/dev/null || true

# WIPE SEMUA SESI LAMA UNTUK MEMBERSIHKAN RAM (Hanya dijalankan sekali)
if [ ! -f /app/data/.wiped_v1 ]; then
  echo "[entrypoint] Membersihkan 7+ sesi nyangkut agar RAM tidak penuh..."
  rm -rf /app/.wwebjs_auth/* 2>/dev/null || true
  rm -rf /app/data/tenants/* 2>/dev/null || true
  mkdir -p /app/data
  touch /app/data/.wiped_v1
fi

echo "[entrypoint] Lock files cleaned. Starting server..."
exec npm start
