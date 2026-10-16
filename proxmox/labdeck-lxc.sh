#!/usr/bin/env bash
# Labdeck – Proxmox VE LXC helper-script
# Kjør på Proxmox-verten (Shell) som root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/sebastiankristo/glass-dash/main/proxmox/labdeck-lxc.sh)"
# Lager en Debian 12-container, installerer Node.js 22 og Labdeck som en systemd-tjeneste på port 7575.
# Alle valg kan overstyres med miljøvariabler, f.eks.:  CTID=150 STORAGE=local-zfs bash labdeck-lxc.sh
set -euo pipefail

YW="\033[33m"; GN="\033[1;92m"; RD="\033[01;31m"; CL="\033[m"
msg(){ echo -e " ${YW}➜${CL} $*"; }
ok(){ echo -e " ${GN}✓${CL} $*"; }
die(){ echo -e " ${RD}✗ $*${CL}"; exit 1; }

command -v pct >/dev/null || die "Dette må kjøres på en Proxmox VE-vert."
[ "$(id -u)" -eq 0 ] || die "Kjør som root."

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME="${HOSTNAME_CT:-labdeck}"
CORES="${CORES:-1}"
RAM="${RAM:-512}"
DISK="${DISK:-4}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"            # dhcp eller f.eks. 10.69.1.50/24
GATEWAY="${GATEWAY:-}"        # påkrevd ved statisk IP, f.eks. 10.69.1.1
STORAGE="${STORAGE:-local-lvm}"
TPL_STORAGE="${TPL_STORAGE:-local}"
BRANCH="${BRANCH:-main}"
REPO="https://github.com/sebastiankristo/glass-dash.git"

echo -e "\n ${GN}Labdeck LXC-installasjon${CL}\n"
if [ -t 0 ] && [ -z "${UNATTENDED:-}" ]; then
  read -rp "  Container-ID [$CTID]: " a; CTID="${a:-$CTID}"
  read -rp "  Hostname [$HOSTNAME]: " a; HOSTNAME="${a:-$HOSTNAME}"
  read -rp "  Disk-lagring [$STORAGE]: " a; STORAGE="${a:-$STORAGE}"
  read -rp "  Nettverksbro [$BRIDGE]: " a; BRIDGE="${a:-$BRIDGE}"
  read -rp "  IP (dhcp eller 10.69.1.50/24) [$NET]: " a; NET="${a:-$NET}"
  if [ "$NET" != "dhcp" ] && [ -z "$GATEWAY" ]; then read -rp "  Gateway: " GATEWAY; fi
fi

NETCFG="name=eth0,bridge=${BRIDGE},ip=${NET}"
[ "$NET" != "dhcp" ] && [ -n "$GATEWAY" ] && NETCFG="${NETCFG},gw=${GATEWAY}"

msg "Henter Debian 12-mal"
pveam update >/dev/null
TPL="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TPL" ] || die "Fant ingen Debian 12-mal."
pveam list "$TPL_STORAGE" | grep -q "$TPL" || pveam download "$TPL_STORAGE" "$TPL" >/dev/null
ok "Mal: $TPL"

msg "Lager container $CTID"
pct create "$CTID" "${TPL_STORAGE}:vztmpl/${TPL}" \
  --hostname "$HOSTNAME" --cores "$CORES" --memory "$RAM" --swap 256 \
  --rootfs "${STORAGE}:${DISK}" --net0 "$NETCFG" \
  --unprivileged 1 --features nesting=1 --onboot 1 \
  --tags labdeck --description "Labdeck dashboard – http://<ip>:7575" >/dev/null
pct start "$CTID"
ok "Container startet"

msg "Venter på nettverk"
for i in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.nodesource.com >/dev/null 2>&1 && break; sleep 2; done

msg "Installerer Node.js 22 og Labdeck (tar et par minutter)"
pct exec "$CTID" -- bash -s "$REPO" "$BRANCH" <<'INNER'
set -euo pipefail
REPO="$1"; BRANCH="$2"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
git clone -q --depth 1 -b "$BRANCH" "$REPO" /opt/labdeck
mkdir -p /opt/labdeck-data
cat >/etc/systemd/system/labdeck.service <<UNIT
[Unit]
Description=Labdeck dashboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/labdeck
Environment=PORT=7575
Environment=DATA_DIR=/opt/labdeck-data
EnvironmentFile=-/opt/labdeck-data/labdeck.env
ExecStart=/usr/bin/node /opt/labdeck/server.js
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
cat >/usr/local/bin/update-labdeck <<'UPD'
#!/usr/bin/env bash
set -e
cd /opt/labdeck && git pull -q && systemctl restart labdeck && echo "Labdeck oppdatert ✓"
UPD
chmod +x /usr/local/bin/update-labdeck
systemctl daemon-reload
systemctl enable -q --now labdeck
INNER
ok "Labdeck installert"

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo -e "\n ${GN}Ferdig!${CL}  Åpne ${YW}http://${IP}:7575${CL}\n"
echo "  Oppdatere senere:   pct exec $CTID -- update-labdeck"
echo "  Secrets (valgfritt): /opt/labdeck-data/labdeck.env i containeren, så 'systemctl restart labdeck'"
echo "  Data ligger i:      /opt/labdeck-data (config.json + secrets.json)"
