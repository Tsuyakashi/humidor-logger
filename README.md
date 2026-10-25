# humidor-logger

Мониторинг хьюмидора: Xiaomi MJWSD06MMC на прошивке pvvx (BTHome v2) → BlueZ на pve-rog → CT 210.

## Сервисы

| Сервис | Что делает | Пишет в БД |
|---|---|---|
| `humidor-collector` | BLE через D-Bus BlueZ хоста, парсинг BTHome, дедуп по packet_id | `readings` |
| `humidor-alerter` | раз в минуту проверяет правила, шлёт в Telegram (только `sendMessage`) | `alerts` |
| `humidor-bot` | long polling, команды `/now`, `/status`, `/history` | — |

Общая БД: SQLite (WAL) `/var/lib/humidor/humidor.db`. Общий код: `packages/core`.

## Развёртывание

```bash
ssh pve-rog 'bash -s' < scripts/host-setup.sh          # прошивка ar3k, bluez, D-Bus policy, subuid
ssh pve-rog 'bash -s -- 210' < scripts/ct-create.sh    # CT, idmap, Node, /etc/default/humidor
vault kv put secret/humidor/telegram bot_token=... chat_ids=...
scripts/secrets.sh 210                                  # /etc/humidor/secrets.env
scripts/deploy.sh 210                                   # build, upload, npm ci, systemd
```

## Конфиг

- `/etc/default/humidor`: `DBUS_SYSTEM_BUS_ADDRESS`, `HUMIDOR_MAC`, `HUMIDOR_DB`, `TZ` (пишет ct-create.sh)
- `/etc/humidor/secrets.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` (пишет secrets.sh)
- `/etc/humidor/thresholds.env` (опционально, читает alerter):
  `HUM_LOW=62 HUM_HIGH=73 HUM_HYST=1.5 HUM_FOR_MIN=30 TEMP_HIGH=25 TEMP_HYST=0.5 TEMP_FOR_MIN=15 STALE_MIN=15 BATT_LOW_V=2.5 REMIND_HOURS=6`

## Логи

```bash
ssh pve-rog 'pct exec 210 -- journalctl -u "humidor-*" -f'
```
