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
apt-get install -y -qq nodejs rsync openssh-client curl ca-certificates >/dev/null
mkdir -p /opt/backup-gui/public /opt/backup-gui/data
curl -fsSL "$RAW/server.js" -o /opt/backup-gui/server.js
curl -fsSL "$RAW/public/index.html" -o /opt/backup-gui/public/index.html
chmod 700 /opt/backup-gui/data
cat >/etc/systemd/system/backup-gui.service <<UNIT
[Unit]
Description=Hytte Backup web-GUI
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
curl -fsSL "$RAW/server.js?\$(date +%s)" -o /opt/backup-gui/server.js
curl -fsSL "$RAW/public/index.html?\$(date +%s)" -o /opt/backup-gui/public/index.html
systemctl restart backup-gui && echo "Hytte Backup oppdatert ✓"
UPD
chmod +x /usr/local/bin/update-backup-gui
ln -sf /usr/local/bin/update-backup-gui /usr/bin/update-backup-gui
systemctl daemon-reload
systemctl enable -q --now backup-gui
systemctl restart backup-gui
INNER

# ── 2. ZFS-hjelper på verten (snapshots etter hver kjøring) ─────────────────
SRC="$(pct config "$CTID" | awk -v d="$DEST_ROOT" -F'[ ,]' '/^mp[0-9]+:/ {for(i=1;i<=NF;i++) if($i=="mp="d) print $2}' | head -1)"
DS=""
[ -n "$SRC" ] && DS="$(zfs list -H -o name "$SRC" 2>/dev/null || true)"
if [ -z "$DS" ]; then
  echo "⚠ Fant ikke ZFS-datasettet bak $DEST_ROOT i CT $CTID (mp-kilde: ${SRC:-ingen}). Snapshots blir ikke tatt."
else
  echo "➜ ZFS-hjelper for datasettet $DS ($SRC)"
  curl -fsSL "$RAW/hytte-zfs?$(date +%s)" -o /usr/local/sbin/hytte-zfs && chmod 755 /usr/local/sbin/hytte-zfs
  echo "DATASET=$DS" > /etc/hytte-zfs.conf
  cat >/etc/systemd/system/hytte-zfs.service <<'UNIT'
[Unit]
Description=Hytte Backup ZFS-hjelper
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hytte-zfs
UNIT
  cat >/etc/systemd/system/hytte-zfs.path <<UNIT
[Unit]
Description=Hytte Backup ZFS-forespørsler
[Path]
PathExistsGlob=$SRC/.hytte/req/*.json
[Install]
WantedBy=multi-user.target
UNIT
  cat >/etc/systemd/system/hytte-zfs.timer <<'UNIT'
[Unit]
Description=Hytte Backup ZFS-oversikt
[Timer]
OnBootSec=30
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
UNIT
  mkdir -p "$SRC/.hytte/req" "$SRC/.hytte/res"
  chown -R 100000:100000 "$SRC/.hytte" 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable -q --now hytte-zfs.path hytte-zfs.timer
  systemctl start hytte-zfs.service
fi

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
echo "✓ Ferdig! Åpne http://${IP}:${PORT}"
echo "  Oppdatere senere: kjør denne kommandoen på nytt (oppdaterer både GUI og ZFS-hjelper)."
