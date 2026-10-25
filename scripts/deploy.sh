#!/usr/bin/env bash
# Сборка локально и выкладка в CT: dist + package.json, npm ci --omit=dev внутри,
# атомарная замена /opt/humidor/app, юниты, рестарт.
# Запуск из корня репо: scripts/deploy.sh <ctid>   (PVE_HOST=pve-rog по умолчанию)
set -euo pipefail

CTID="${1:?usage: deploy.sh <ctid>}"
PVE_HOST="${PVE_HOST:-pve-rog}"
cd "$(dirname "$0")/.."

log() { echo "[deploy] $*"; }

log "build"
npm ci --no-audit --no-fund --loglevel=error
npm run build

log "upload"
tar czf - \
  package.json package-lock.json \
  packages/*/package.json packages/*/dist \
  services/*/package.json services/*/dist \
  deploy/systemd \
| ssh "$PVE_HOST" "pct exec $CTID -- bash -c 'rm -rf /opt/humidor/app.new && mkdir -p /opt/humidor/app.new && tar xzf - -C /opt/humidor/app.new'"

log "install & restart"
ssh "$PVE_HOST" "pct exec $CTID -- bash -s" <<'EOF'
set -euo pipefail
cd /opt/humidor/app.new
npm ci --omit=dev --no-audit --no-fund --loglevel=error

rm -rf /opt/humidor/app.old
if [[ -d /opt/humidor/app ]]; then mv /opt/humidor/app /opt/humidor/app.old; fi
mv /opt/humidor/app.new /opt/humidor/app

install -m 0644 /opt/humidor/app/deploy/systemd/humidor-*.service /etc/systemd/system/
systemctl daemon-reload

units=(humidor-collector)
if [[ -f /etc/humidor/secrets.env ]]; then
  units+=(humidor-alerter humidor-bot)
else
  echo "[deploy] /etc/humidor/secrets.env missing: alerter/bot not started (run scripts/secrets.sh)"
fi
systemctl enable --quiet "${units[@]}"
systemctl restart "${units[@]}"
sleep 3
systemctl --no-pager --lines=5 status "${units[@]}" || true
EOF
