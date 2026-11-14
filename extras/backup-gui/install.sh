#!/usr/bin/env bash
# Hytte Backup – installerer web-GUI-et i backup-containeren og ZFS-hjelperen på Proxmox-verten.
# Kjør på Proxmox-verten:  CTID=103 bash -c "$(curl -fsSL <raw-url>/install.sh)"
set -euo pipefail
CTID="${CTID:-103}"
BRANCH="${BRANCH:-backup-gui}"
RAW="https://raw.githubusercontent.com/SebastianKristo/glass-dash/${BRANCH}/extras/backup-gui"
PORT="${PORT:-8090}"
DEST_ROOT="${DEST_ROOT:-/mnt/unraid}"

command -v pct >/dev/null || { echo "Kjør dette på Proxmox-verten."; exit 1; }
pct status "$CTID" >/dev/null || { echo "Fant ikke container $CTID."; exit 1; }
echo "➜ Installerer Hytte Backup i CT $CTID (port $PORT, lagrer til $DEST_ROOT)"

# ── 1. Web-GUI i containeren ────────────────────────────────────────────────
pct exec "$CTID" -- bash -s "$RAW" "$PORT" "$DEST_ROOT" <<'INNER'
set -euo pipefail
RAW="$1"; PORT="$2"; DEST_ROOT="$3"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync openssh-client curl ca-certificates tar >/dev/null
# Node 22 (zstd i zlib krever 22.15+)
if ! node -e "process.exit(typeof require('zlib').zstdCompressSync==='function'?0:1)" 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
mkdir -p /opt/backup-gui/public/vendor /opt/backup-gui/data
for f in server.js store.js public/index.html public/vendor/lucide.min.js; do curl -fsSL "$RAW/$f?$(date +%s)" -o "/opt/backup-gui/$f"; done
chmod 700 /opt/backup-gui/data
cat >/etc/systemd/system/backup-gui.service <<UNIT
[Unit]
Description=Hytte backup
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/backup-gui
Environment=PORT=$PORT
Environment=DATA_DIR=/opt/backup-gui/data
Environment=DEST_ROOT=$DEST_ROOT
ExecStart=/usr/bin/node /opt/backup-gui/server.js
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
cat >/usr/local/bin/update-backup-gui <<UPD
#!/usr/bin/env bash
set -e
for f in server.js store.js public/index.html public/vendor/lucide.min.js; do curl -fsSL "$RAW/\$f?\$(date +%s)" -o "/opt/backup-gui/\$f"; done
systemctl restart backup-gui && echo "Hytte Backup oppdatert ✓"
UPD
chmod +x /usr/local/bin/update-backup-gui
ln -sf /usr/local/bin/update-backup-gui /usr/bin/update-backup-gui
systemctl daemon-reload
systemctl enable -q --now backup-gui
systemctl restart backup-gui
INNER

# ── 2. v3 trenger ikke ZFS-hjelperen lenger (arkivet har egne versjoner) ──
systemctl disable --now hytte-zfs.path hytte-zfs.timer >/dev/null 2>&1 || true

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
echo "✓ Ferdig! Åpne http://${IP}:${PORT}"
echo "  Oppdatere senere: kjør denne kommandoen på nytt (oppdaterer både GUI og ZFS-hjelper)."
