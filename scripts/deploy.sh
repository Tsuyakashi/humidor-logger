#!/usr/bin/env bash
# Сборка локально и выкладка в CT: dist (вместе с public/ у web) + package.json,
# npm ci --omit=dev внутри, атомарная замена /opt/humidor/app, все юниты из deploy/systemd, рестарт.
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
# optional usocket из dbus-next тянет node-gyp, он не нужен
npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error

rm -rf /opt/humidor/app.old
if [[ -d /opt/humidor/app ]]; then mv /opt/humidor/app /opt/humidor/app.old; fi
mv /opt/humidor/app.new /opt/humidor/app

install -m 0644 /opt/humidor/app/deploy/systemd/humidor-*.service /etc/systemd/system/
systemctl daemon-reload

# Юниты, которым нужен secrets.env, без него не стартуют — пропускаем
units=()
for f in /opt/humidor/app/deploy/systemd/humidor-*.service; do
  u=$(basename "$f" .service)
  if grep -qx 'EnvironmentFile=/etc/humidor/secrets.env' "$f" && [[ ! -f /etc/humidor/secrets.env ]]; then
    echo "[deploy] $u skipped: /etc/humidor/secrets.env missing (run scripts/secrets.sh)"
    continue
  fi
  units+=("$u")
done
systemctl enable --quiet "${units[@]}"
systemctl restart "${units[@]}"
sleep 3
systemctl --no-pager --lines=5 status "${units[@]}" || true
EOF
