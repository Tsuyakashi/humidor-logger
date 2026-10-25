#!/usr/bin/env bash
# Tailscale в CT + Funnel на humidor-web (127.0.0.1:PORT) -> https://humidor.<tailnet>.ts.net
# Предварительно: vault kv put tailscale/humidor auth-key=tskey-auth-...  (ключ с тегом tag:humidor)
# Идемпотентный. Запуск: scripts/tailscale.sh <ctid>   (VAULT_ADDR/VAULT_TOKEN из окружения)
set -euo pipefail

CTID="${1:?usage: tailscale.sh <ctid>}"
PVE_HOST="${PVE_HOST:-pve-rog}"
VAULT_TS_PATH="${VAULT_TS_PATH:-tailscale/humidor}"
PORT="${HUMIDOR_WEB_PORT:-8080}"
TS_HOSTNAME="${TS_HOSTNAME:-humidor}"
TS_TAGS="${TS_TAGS:-tag:humidor}"

log() { echo "[tailscale] $*"; }
# bash -c в CT; скрипт и аргументы экранируются для shell'а на хосте
ct_bash() {
  local script=$1; shift
  ssh "$PVE_HOST" "pct exec $CTID -- bash -c $(printf '%q' "$script") _ $(printf '%q ' "$@")"
}

# 1. Установка и userspace-режим (в unprivileged LXC нет /dev/net/tun)
log "install & configure tailscaled"
ssh "$PVE_HOST" "pct exec $CTID -- bash -s" <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v tailscale >/dev/null; then
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -q
  apt-get install -y -q tailscale
fi

want='FLAGS="--tun=userspace-networking"'
changed=0
if ! grep -qxF "$want" /etc/default/tailscaled 2>/dev/null; then
  if grep -q '^FLAGS=' /etc/default/tailscaled 2>/dev/null; then
    sed -i "s|^FLAGS=.*|$want|" /etc/default/tailscaled
  else
    echo "$want" >> /etc/default/tailscaled
  fi
  changed=1
fi
systemctl enable --quiet tailscaled
if (( changed )); then systemctl restart tailscaled; else systemctl start tailscaled; fi
EOF

# 2. Логин, если ещё не залогинен. Ключ идёт через stdin во временный файл (0600):
#    в командной строке он был бы виден в ps хоста
state() { ct_bash 'tailscale status --json --peers=false 2>/dev/null | grep -o "\"BackendState\": *\"[A-Za-z]*\"" | grep -o "[A-Za-z]*\"$" | tr -d "\""' || true; }
for _ in $(seq 1 10); do
  st=$(state)
  [[ -n $st && $st != NoState ]] && break
  sleep 1
done
log "backend state: ${st:-unknown}"

if [[ $st != Running ]]; then
  log "tailscale up as ${TS_HOSTNAME} (${TS_TAGS})"
  vault kv get -field=auth-key "$VAULT_TS_PATH" | ct_bash '
    set -euo pipefail
    f=$(mktemp)
    trap "rm -f $f" EXIT
    cat > "$f"
    tailscale up --auth-key="file:$f" --hostname="$1" --advertise-tags="$2"
  ' "$TS_HOSTNAME" "$TS_TAGS"
fi

# 3. Funnel на локальный web
log "funnel -> 127.0.0.1:${PORT}"
ct_bash 'tailscale funnel --bg "$1" >/dev/null && tailscale funnel status' "$PORT"

cat <<'EOF'

[tailscale] Напоминание: в tailscale-acl должно быть
  "tagOwners": {"tag:humidor": ["autogroup:admin"]},
  "nodeAttrs": [{"target": ["tag:humidor"], "attr": ["funnel"]}]
и в tailnet включены HTTPS-сертификаты (MagicDNS + HTTPS).
EOF
