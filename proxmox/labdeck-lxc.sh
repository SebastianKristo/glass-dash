#!/usr/bin/env bash
# Labdeck – Proxmox VE LXC helper-script
# Kjør på Proxmox-verten (Shell) som root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/sebastiankristo/glass-dash/main/proxmox/labdeck-lxc.sh)"
# Lager en Debian 12-container, installerer Node.js 22 og Labdeck som en systemd-tjeneste.
# Dashbordet svarer på http://<hostname>.local (mDNS/Bonjour via avahi) på port 80, så ett bokmerke holder.
# Alle valg kan overstyres med miljøvariabler, f.eks.:  CTID=150 STORAGE=local-zfs PORT=7575 bash labdeck-lxc.sh
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
STORAGE="${STORAGE:-}"          # tom = første aktive lagring som støtter containere
TPL_STORAGE="${TPL_STORAGE:-}"  # tom = første aktive lagring som støtter maler
PORT="${PORT:-80}"              # 80 = ingen port i adressen (http://labdeck.local). PORT=7575 gir gammel oppførsel.
MDNS="${MDNS:-1}"               # 1 = annonser <hostname>.local med avahi, 0 = av
BRANCH="${BRANCH:-main}"
REPO="https://github.com/sebastiankristo/glass-dash.git"

# Første aktive lagring som støtter innholdstypen (rootdir = containerdisker, vztmpl = maler).
# Unngår feil på verter der local-lvm er fjernet eller heter noe annet.
pick_storage(){ pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}'; }
[ -n "$STORAGE" ] || STORAGE="$(pick_storage rootdir)"
[ -n "$TPL_STORAGE" ] || TPL_STORAGE="$(pick_storage vztmpl)"
[ -n "$STORAGE" ] || die "Fant ingen lagring for containerdisker. Se 'pvesm status -content rootdir' og sett STORAGE=..."
[ -n "$TPL_STORAGE" ] || die "Fant ingen lagring for maler. Aktiver 'Container template' på en lagring, eller sett TPL_STORAGE=..."

echo -e "\n ${GN}Labdeck LXC-installasjon${CL}\n"
if [ -t 0 ] && [ -z "${UNATTENDED:-}" ]; then
  read -rp "  Container-ID [$CTID]: " a; CTID="${a:-$CTID}"
  read -rp "  Hostname [$HOSTNAME]: " a; HOSTNAME="${a:-$HOSTNAME}"
  read -rp "  Disk-lagring [$STORAGE]: " a; STORAGE="${a:-$STORAGE}"
  read -rp "  Nettverksbro [$BRIDGE]: " a; BRIDGE="${a:-$BRIDGE}"
  read -rp "  IP (dhcp eller 10.69.1.50/24) [$NET]: " a; NET="${a:-$NET}"
  if [ "$NET" != "dhcp" ] && [ -z "$GATEWAY" ]; then read -rp "  Gateway: " GATEWAY; fi
  read -rp "  Port (80 = ingen port i adressen) [$PORT]: " a; PORT="${a:-$PORT}"
fi
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Ugyldig port: $PORT"

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
  --tags labdeck --description "Labdeck dashboard – http://${HOSTNAME}.local$([ "$PORT" = 80 ] || echo ":$PORT")" >/dev/null
pct start "$CTID"
ok "Container startet"

msg "Venter på nettverk"
for i in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.nodesource.com >/dev/null 2>&1 && break; sleep 2; done

msg "Installerer Node.js 22 og Labdeck (tar et par minutter)"
pct exec "$CTID" -- bash -s "$REPO" "$BRANCH" "$PORT" "$MDNS" "$HOSTNAME" <<'INNER'
set -euo pipefail
REPO="$1"; BRANCH="$2"; PORT="$3"; MDNS="$4"; HN="$5"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git locales >/dev/null
sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen >/dev/null 2>&1 || true
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
Environment=PORT=${PORT}
Environment=DATA_DIR=/opt/labdeck-data
EnvironmentFile=-/opt/labdeck-data/labdeck.env
# Lar tjenesten bruke port under 1024 (f.eks. 80).
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/bin/node /opt/labdeck/server.js
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
# PORT i labdeck.env vil overstyre valget over. Fjern den så porten fra installasjonen gjelder.
[ -f /opt/labdeck-data/labdeck.env ] && sed -i '/^PORT=/d' /opt/labdeck-data/labdeck.env

# mDNS: <hostname>.local på lokalnettet (Mac, iPhone, Windows, Linux).
if [ "$MDNS" = 1 ]; then
  apt-get install -y -qq avahi-daemon >/dev/null
  # Uprivilegert LXC: prosessgrensen i avahi stopper ellers tjenesten.
  sed -i 's/^rlimit-nproc/#rlimit-nproc/' /etc/avahi/avahi-daemon.conf
  hostnamectl set-hostname "$HN" 2>/dev/null || echo "$HN" > /etc/hostname
  systemctl enable -q avahi-daemon
  systemctl restart avahi-daemon
fi
cat >/usr/local/bin/update-labdeck <<'UPD'
#!/usr/bin/env bash
set -e
cd /opt/labdeck && git pull -q && systemctl restart labdeck && echo "Labdeck oppdatert ✓"
UPD
chmod +x /usr/local/bin/update-labdeck
# pct exec søker bare i /usr/bin og /bin, ikke /usr/local/bin
ln -sf /usr/local/bin/update-labdeck /usr/bin/update-labdeck
systemctl daemon-reload
systemctl enable -q --now labdeck
INNER
ok "Labdeck installert"

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
SFX=""; [ "$PORT" = 80 ] || SFX=":$PORT"
echo -e "\n ${GN}Ferdig!${CL}"
if [ "$MDNS" = 1 ]; then
  echo -e "  Åpne ${YW}http://${HOSTNAME}.local${SFX}${CL}   (eller http://${IP}${SFX})"
  echo "  .local virker på Mac, iPhone, Windows og Linux på samme nett. Android og andre VLAN:"
  echo "  bruk IP-en, eller lag en DNS-oppføring (f.eks. ${HOSTNAME}.lan) i AdGuard/Pi-hole."
else
  echo -e "  Åpne ${YW}http://${IP}${SFX}${CL}"
fi
echo
echo "  Oppdatere senere:   pct exec $CTID -- update-labdeck"
echo "  Secrets (valgfritt): /opt/labdeck-data/labdeck.env i containeren, så 'systemctl restart labdeck'"
echo "  Data ligger i:      /opt/labdeck-data (config.json + secrets.json)"
