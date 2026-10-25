#!/usr/bin/env bash
# Подготовка Proxmox-хоста под humidor-logger:
#   прошивка AR3012 (нет в pve-firmware), bluez, D-Bus policy для CT.
# D-Bus EXTERNAL auth сравнивает uid, заявленный клиентом, с SO_PEERCRED.
# В unprivileged CT они не совпадают (0 vs 100000) -> daemon рвёт коннект.
# Поэтому один uid (BUS_UID) мапится в CT 1:1 и только он пускается к org.bluez.
# Идемпотентный. Запуск: ssh pve-rog 'bash -s' < scripts/host-setup.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

BUS_UID="${BUS_UID:-2000}"
BUS_USER="${BUS_USER:-ct-bluez}"
FW_DIR=/lib/firmware/updates/ar3k
FW_BASE=https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/ar3k
FW_FILES=(AthrBT_0x01020200.dfu ramps_0x01020200_26.dfu ramps_0x01020200_40.dfu)
POLICY=/etc/dbus-1/system.d/lxc-bluez.conf

log() { echo "[host-setup] $*"; }

# 1. Прошивка AR3012
mkdir -p "$FW_DIR"
fw_new=0
for f in "${FW_FILES[@]}"; do
  if [[ ! -s $FW_DIR/$f ]]; then
    log "fetch firmware $f"
    curl -fsSL -o "$FW_DIR/$f" "$FW_BASE/$f"
    fw_new=1
  fi
done

# 2. bluez
if ! dpkg -s bluez >/dev/null 2>&1; then
  log "install bluez"
  apt-get update -q </dev/null
  apt-get install -y -q bluez </dev/null
fi
systemctl enable --now bluetooth

# Прошивка только что легла или hci0 нет: перезагрузить драйвер.
# После заливки прошивки чип переэнумерируется ~6 с.
if (( fw_new )) || [[ ! -e /sys/class/bluetooth/hci0 ]]; then
  log "reload ath3k/btusb"
  modprobe -r btusb ath3k 2>/dev/null || true
  modprobe ath3k
  modprobe btusb
  for _ in $(seq 1 20); do
    [[ -e /sys/class/bluetooth/hci0 ]] && break
    sleep 1
  done
fi

[[ -e /sys/class/bluetooth/hci0 ]] || { log "hci0 not found"; exit 1; }
timeout 5 bluetoothctl list </dev/null | grep -q Controller \
  || { log "bluetoothd does not see controller"; exit 1; }
timeout 5 bluetoothctl power on </dev/null >/dev/null

# 3. Хостовый юзер-заглушка под BUS_UID (чтобы uid не занял кто-то ещё) + разрешение на idmap
if ! getent passwd "$BUS_UID" >/dev/null; then
  log "create host user $BUS_USER ($BUS_UID)"
  useradd --system --uid "$BUS_UID" --no-create-home --shell /usr/sbin/nologin "$BUS_USER"
fi
grep -qx "root:${BUS_UID}:1" /etc/subuid || echo "root:${BUS_UID}:1" >> /etc/subuid

# 4. D-Bus policy: BUS_UID -> только org.bluez
cat > "$POLICY" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="${BUS_UID}">
    <allow send_destination="org.bluez"/>
    <allow receive_sender="org.bluez"/>
  </policy>
</busconfig>
EOF
systemctl reload dbus

log "done: $(timeout 5 bluetoothctl list </dev/null)"
