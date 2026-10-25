#!/usr/bin/env bash
# Токен бота и chat_id из Vault -> /etc/humidor/secrets.env (0600 root) в CT.
# Предварительно (mount на проект, KV v2):
#   vault secrets enable -path=humidor -version=2 kv
#   vault kv put humidor/telegram bot_token=... chat_ids=123456789
# Запуск: scripts/secrets.sh <ctid>   (VAULT_ADDR/VAULT_TOKEN из окружения)
set -euo pipefail

CTID="${1:?usage: secrets.sh <ctid>}"
PVE_HOST="${PVE_HOST:-pve-rog}"
VAULT_PATH="${VAULT_PATH:-humidor/telegram}"

token=$(vault kv get -field=bot_token "$VAULT_PATH")
chats=$(vault kv get -field=chat_ids "$VAULT_PATH")

printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_IDS=%s\n' "$token" "$chats" \
| ssh "$PVE_HOST" "pct exec $CTID -- bash -c 'install -d -m 0700 /etc/humidor && umask 077 && cat > /etc/humidor/secrets.env'"

echo "[secrets] written to CT $CTID:/etc/humidor/secrets.env"
