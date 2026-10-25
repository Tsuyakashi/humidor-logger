#!/usr/bin/env bash
# sqlite3 к БД в CT. SQL из stdin; если stdin — терминал, показывает последние 10 измерений.
# Под юзером humidor: root мог бы создать -wal/-shm, недоступные сервисам.
# Запуск: scripts/db.sh <ctid>   или   echo 'SELECT count(*) FROM readings;' | scripts/db.sh <ctid>
set -euo pipefail

CTID="${1:?usage: db.sh <ctid>}"
PVE_HOST="${PVE_HOST:-pve-rog}"
DB=/var/lib/humidor/humidor.db

DEFAULT_SQL="SELECT datetime(ts/1000, 'unixepoch', 'localtime') AS time,
       temperature, humidity, battery, voltage, rssi, packet_id
FROM readings ORDER BY ts DESC LIMIT 10;"

run() { ssh "$PVE_HOST" "pct exec $CTID -- runuser -u humidor -- sqlite3 -header -column $DB"; }

if [[ -t 0 ]]; then
  printf '%s\n' "$DEFAULT_SQL" | run
else
  run
fi
