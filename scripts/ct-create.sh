#!/usr/bin/env bash
# Создание и настройка CT для humidor-logger: unprivileged Debian 13,
# D-Bus хоста в /mnt/host-dbus, uid BUS_UID замаплен 1:1 (см. host-setup.sh),
# сервисный юзер humidor с этим uid, Node.js, каталоги и /etc/default/humidor.
# Идемпотентный. Запуск: ssh pve-rog 'bash -s -- <ctid>' < scripts/ct-create.sh
# Переопределение: CT_IP=192.168.100.50/24,gw=192.168.100.1 CT_STORAGE=... HUMIDOR_MAC=...
set -euo pipefail

CTID="${1:?usage: ct-create.sh <ctid>}"
CT_HOSTNAME="${CT_HOSTNAME:-humidor}"
TEMPLATE="${CT_TEMPLATE:-debian-13-standard_13.6-1_amd64.tar.zst}"
STORAGE="${CT_STORAGE:-local-lvm}"
BRIDGE="${CT_BRIDGE:-vmbr0}"
NET_IP="${CT_IP:-dhcp}"
BUS_UID="${BUS_UID:-2000}"
HUMIDOR_MAC="${HUMIDOR_MAC:-A4:C1:38:1D:96:98}"
TZ_NAME="${TZ_NAME:-Europe/Minsk}"
NODE_MAJOR="${NODE_MAJOR:-24}"
APP_USER=humidor
CONF="/etc/pve/lxc/${CTID}.conf"
# Не в /run: systemd в CT монтирует tmpfs поверх /run и прячет bind-mount
DBUS_MOUNT='lxc.mount.entry: /run/dbus mnt/host-dbus none bind,create=dir 0 0'
DBUS_ADDR='unix:path=/mnt/host-dbus/system_bus_socket'
IDMAP=(
  "lxc.idmap: u 0 100000 ${BUS_UID}"
  "lxc.idmap: u ${BUS_UID} ${BUS_UID} 1"
  "lxc.idmap: u $((BUS_UID + 1)) $((100000 + BUS_UID + 1)) $((65536 - BUS_UID - 1))"
  "lxc.idmap: g 0 100000 65536"
)

log() { echo "[ct-create] $*"; }
ct()  { pct exec "$CTID" -- "$@" </dev/null; }   # </dev/null: не съесть stdin со скриптом

[[ -f /etc/dbus-1/system.d/lxc-bluez.conf ]] || { log "run host-setup.sh first"; exit 1; }
grep -qx "root:${BUS_UID}:1" /etc/subuid || { log "no root:${BUS_UID}:1 in /etc/subuid, run host-setup.sh"; exit 1; }

# 1. Шаблон
if ! pveam list local | grep -q "$TEMPLATE"; then
  pveam update >/dev/null
  pveam download local "$TEMPLATE"
fi

# 2. CT
restart=0
if [[ -f $CONF ]]; then
  log "CT $CTID exists, skip create"
else
  log "create CT $CTID"
  pct create "$CTID" "local:vztmpl/$TEMPLATE" \
    --hostname "$CT_HOSTNAME" --ostype debian \
    --unprivileged 1 --features nesting=1 \
    --cores 1 --memory 512 --swap 256 \
    --rootfs "${STORAGE}:4" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=${NET_IP}" \
    --onboot 1 \
    --ssh-public-keys /root/.ssh/authorized_keys
fi

# 3. D-Bus хоста внутрь CT (старые варианты entry вычищаем)
if grep -q '^lxc.mount.entry: /run/dbus ' "$CONF" && ! grep -qxF "$DBUS_MOUNT" "$CONF"; then
  sed -i '\#^lxc.mount.entry: /run/dbus #d' "$CONF"
fi
if ! grep -qxF "$DBUS_MOUNT" "$CONF"; then
  echo "$DBUS_MOUNT" >> "$CONF"
  restart=1
fi

# 4. idmap: BUS_UID 1:1, остальное как у обычного unprivileged CT
idmap_ok=1
for l in "${IDMAP[@]}"; do grep -qxF "$l" "$CONF" || idmap_ok=0; done
if (( ! idmap_ok )); then
  sed -i '/^lxc.idmap:/d' "$CONF"
  printf '%s\n' "${IDMAP[@]}" >> "$CONF"
  restart=1
fi

# idmap применяется только на холодном старте
if pct status "$CTID" | grep -q running; then
  if (( restart )); then
    log "restart CT"
    pct stop "$CTID"
    pct start "$CTID"
  fi
else
  log "start CT"
  pct start "$CTID"
fi

# 5. Ждём сеть
log "wait for network"
ok=0
for _ in $(seq 1 30); do
  if ct getent hosts deb.debian.org >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
(( ok )) || { log "no network in CT"; exit 1; }

# 6. Провижн внутри CT (heredoc в кавычках, переменные передаются через env)
log "provision"
pct exec "$CTID" -- env \
  BUS_UID="$BUS_UID" APP_USER="$APP_USER" DBUS_ADDR="$DBUS_ADDR" \
  HUMIDOR_MAC="$HUMIDOR_MAC" TZ_NAME="$TZ_NAME" NODE_MAJOR="$NODE_MAJOR" \
  bash -s <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8

apt-get update -q
apt-get install -y -q curl ca-certificates

ln -sf "/usr/share/zoneinfo/${TZ_NAME}" /etc/localtime
echo "$TZ_NAME" > /etc/timezone

id "$APP_USER" >/dev/null 2>&1 || \
  useradd --system --uid "$BUS_UID" --home /opt/humidor --no-create-home --shell /usr/sbin/nologin "$APP_USER"

cur=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( cur < NODE_MAJOR )); then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -q nodejs
fi

# остатки python-прототипа
if [[ -f /opt/humidor/pyvenv.cfg ]]; then
  rm -rf /opt/humidor/{bin,include,lib,lib64,pyvenv.cfg,probe.py}
fi

install -d -m 0755 /opt/humidor
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" /var/lib/humidor
install -d -m 0700 /etc/humidor

cat > /etc/default/humidor <<ENV
DBUS_SYSTEM_BUS_ADDRESS=${DBUS_ADDR}
HUMIDOR_MAC=${HUMIDOR_MAC}
HUMIDOR_DB=/var/lib/humidor/humidor.db
TZ=${TZ_NAME}
ENV
echo "node $(node --version)"
EOF

# 7. Проверка: BlueZ хоста виден из CT под APP_USER
log "check org.bluez from CT as ${APP_USER}"
if ct runuser -u "$APP_USER" -- env DBUS_SYSTEM_BUS_ADDRESS="$DBUS_ADDR" \
     busctl --system tree org.bluez --no-pager | grep -q /org/bluez/hci0; then
  log "done: hci0 visible in CT $CTID"
else
  log "org.bluez not reachable from CT"
  exit 1
fi
