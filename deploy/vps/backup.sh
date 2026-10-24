#!/bin/sh
# Nightly backup on the VPS (cron: 0 3 * * *  /opt/lay/deploy/vps/backup.sh >> /var/log/lay-backup.log 2>&1)
# 1. a consistent snapshot through the app (same route the off-host Windows task uses)
# 2. an off-box copy, so losing the VPS never loses the data (rclone remote set up once: Hetzner Storage Box,
#    Backblaze B2, Cloudflare R2, …). Backups hold customer data: the remote must be private.
set -eu
cd "$(dirname "$0")/../.."
OUT=${LAY_BACKUP_DIR:-/var/backups/lay}
docker compose -f deploy/vps/docker-compose.yml exec -T lay \
  node scripts/backup-db.js --base-url http://127.0.0.1:8080 --out /data/backups --keep 7
mkdir -p "$OUT"
docker compose -f deploy/vps/docker-compose.yml cp lay:/data/backups/. "$OUT/"
if [ -n "${LAY_BACKUP_REMOTE:-}" ]; then rclone copy "$OUT" "$LAY_BACKUP_REMOTE" --max-age 48h; fi
