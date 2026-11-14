#!/usr/bin/env bash
# Hytte Backup – installerer web-GUI-et i backup-containeren på Proxmox.
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
curl -fsSL "$RAW/server.js" -o /opt/backup-gui/server.js
curl -fsSL "$RAW/public/index.html" -o /opt/backup-gui/public/index.html
systemctl restart backup-gui && echo "Hytte Backup oppdatert ✓"
UPD
chmod +x /usr/local/bin/update-backup-gui
systemctl daemon-reload
systemctl enable -q --now backup-gui
systemctl restart backup-gui
INNER

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
echo "✓ Ferdig! Åpne http://${IP}:${PORT}"
echo "  1. Velg passord første gang du åpner siden."
echo "  2. Innstillinger → kopier nøkkelen → lim inn i Unraid under Users → root → SSH authorized keys."
echo "  3. Skriv inn Unraid-adressen, trykk «Test tilkobling», og lag en backup med «+ Ny backup»."
echo "  Oppdatere senere: pct exec $CTID -- update-backup-gui"
