# humidor-logger

Мониторинг хьюмидора: Xiaomi MJWSD06MMC на прошивке pvvx (BTHome v2) → BlueZ на pve-rog → CT 210.

## Сервисы

| Сервис | Что делает | Пишет в БД |
|---|---|---|
| `humidor-collector` | BLE через D-Bus BlueZ хоста, парсинг BTHome, дедуп по packet_id | `readings` |
| `humidor-alerter` | раз в минуту проверяет правила, шлёт в Telegram (только `sendMessage`) | `alerts` |
| `humidor-bot` | long polling, команды `/now`, `/status`, `/history` | — |
| `humidor-web` | страница с графиком и `/api/now`, `/api/series` на `127.0.0.1:8080`, наружу через Tailscale Funnel | — |

Общая БД: SQLite (WAL) `/var/lib/humidor/humidor.db`. Общий код: `packages/core`.

## Развёртывание

```bash
ssh pve-rog 'bash -s' < scripts/host-setup.sh          # прошивка ar3k, bluez, D-Bus policy, subuid
ssh pve-rog 'bash -s -- 210' < scripts/ct-create.sh    # CT, idmap, Node, /etc/default/humidor
vault secrets enable -path=humidor -version=2 kv
vault kv put humidor/telegram bot_token=... chat_ids=...
scripts/secrets.sh 210                                  # /etc/humidor/secrets.env
scripts/deploy.sh 210                                   # build, upload, npm ci, все юниты из deploy/systemd
vault kv put tailscale/humidor auth-key=tskey-auth-...
scripts/tailscale.sh 210                                # tailscale в CT + Funnel на humidor-web
```

Юниты, которым нужен `secrets.env`, deploy.sh пропускает, пока его нет в CT; collector и web стартуют без него.

## Веб и Tailscale Funnel

`humidor-web` слушает только loopback и отдаёт только температуру и влажность. Наружу его выводит
`scripts/tailscale.sh <ctid>`: ставит tailscale в CT (userspace networking — в unprivileged LXC нет `/dev/net/tun`),
логинится auth key'ем из Vault (`VAULT_TS_PATH`, по умолчанию `tailscale/humidor`, поле `auth-key`)
как `humidor` с тегом `tag:humidor` и включает `tailscale funnel` на порт web.
Страница: `https://humidor.<tailnet>.ts.net`.

В tailscale-acl (отдельный репо) нужно:

```json
"tagOwners": {"tag:humidor": ["autogroup:admin"]},
"nodeAttrs": [{"target": ["tag:humidor"], "attr": ["funnel"]}]
```

API: `GET /api/now` → `{ ts, temperature, humidity }` (204, если данных нет);
`GET /api/series?range=6h|24h|7d|30d` → `{ range, from, to, bucketMs, rhBand, points: [{ ts, t, h }] }`.
Ответы кэшируются на 30 с.

Превью ссылки (Open Graph): статичные тексты в `index.html` и `public/og.png`. Картинку генерирует
`python3 scripts/og-image.py` (Pillow, шрифт с кириллицей через `fc-match`), результат коммитится.

## БД

```bash
scripts/db.sh 210                                         # последние 10 измерений
echo 'SELECT count(*) FROM readings;' | scripts/db.sh 210 # произвольный SQL из stdin
```

## Конфиг

- `/etc/default/humidor`: `DBUS_SYSTEM_BUS_ADDRESS`, `HUMIDOR_MAC`, `HUMIDOR_DB`, `TZ` (пишет ct-create.sh)
- `/etc/humidor/secrets.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` (пишет secrets.sh)
- `/etc/humidor/thresholds.env` (опционально, читает alerter):
  `HUM_LOW=62 HUM_HIGH=73 HUM_HYST=1.5 HUM_FOR_MIN=30 TEMP_HIGH=25 TEMP_HYST=0.5 TEMP_FOR_MIN=15 STALE_MIN=15 BATT_LOW_V=2.5 REMIND_HOURS=6`
- `/etc/humidor/web.env` (опционально, читает web): `HUMIDOR_WEB_PORT=8080 WEB_RH_BAND=65,70 WEB_PUBLIC_URL=https://humidor.tail65829d.ts.net`
  (`WEB_PUBLIC_URL` — база абсолютных URL для превью ссылки в мессенджерах, `og:url`/`og:image`)

## Логи

```bash
ssh pve-rog 'pct exec 210 -- journalctl -u "humidor-*" -f'
```
