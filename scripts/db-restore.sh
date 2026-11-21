#!/usr/bin/env bash
# Восстановление БД и env-файлов humidor в CT из бэкапа.
# Сервисы останавливаются, старые -wal/-shm удаляются, БД пишется под humidor
# (атомарно через .tmp), env-файлы кладутся в /etc/humidor (0600 root).
# Запуск: scripts/db-restore.sh <ctid> <humidor.db> [humidor-env.tgz]   (PVE_HOST=pve-rog по умолчанию)
set -euo pipefail

CTID="${1:?usage: db-restore.sh <ctid> <humidor.db> [env.tgz]}"
DB_SRC="${2:?usage: db-restore.sh <ctid> <humidor.db> [env.tgz]}"
ENV_TGZ="${3:-}"
PVE_HOST="${PVE_HOST:-pve-rog}"
DB=/var/lib/humidor/humidor.db
UNITS='humidor-collector humidor-alerter humidor-bot humidor-web'

log() { echo "[db-restore] $*"; }
ct()  { ssh "$PVE_HOST" "pct exec $CTID -- $*"; }

[[ -s $DB_SRC ]] || { log "no such file: $DB_SRC"; exit 1; }
if command -v sqlite3 >/dev/null; then
  sqlite3 -readonly "$DB_SRC" 'PRAGMA integrity_check;' | grep -qx ok \
    || { log "integrity_check failed on $DB_SRC"; exit 1; }
fi

log "stop units (если уже задеплоены)"
ct "systemctl stop $UNITS" </dev/null 2>/dev/null || true

log "upload db -> CT $CTID:$DB"
ct "runuser -u humidor -- sh -c 'set -e; rm -f $DB-wal $DB-shm $DB.tmp; cat > $DB.tmp; sqlite3 -readonly $DB.tmp \"PRAGMA integrity_check;\" | grep -qx ok; mv $DB.tmp $DB'" < "$DB_SRC" \
  || { log "upload or integrity_check in CT failed, $DB не тронут"; exit 1; }

if [[ -n $ENV_TGZ ]]; then
  log "env files -> /etc/humidor"
  ct "bash -c 'install -d -m 0700 /etc/humidor && tar xzf - -C /etc/humidor --no-same-owner && chmod 0600 /etc/humidor/*.env'" < "$ENV_TGZ"
fi

ct "runuser -u humidor -- sqlite3 $DB \"SELECT count(*), datetime(max(ts)/1000,'unixepoch','localtime') FROM readings;\"" </dev/null

log "start units, что уже установлены"
ct "bash -c 'for u in $UNITS; do [[ -f /etc/systemd/system/\$u.service ]] && systemctl start \$u; done; true'" </dev/null
