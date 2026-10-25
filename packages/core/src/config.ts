// Конфиг из env. Каждый сервис берёт только свои секции,
// чтобы collector не требовал токен бота и т.п.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is required`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}

export function commonConfig() {
  return {
    dbPath: process.env.HUMIDOR_DB ?? '/var/lib/humidor/humidor.db',
  };
}

export function collectorConfig() {
  return {
    ...commonConfig(),
    mac: required('HUMIDOR_MAC').toUpperCase(),
    adapterPath: process.env.HUMIDOR_ADAPTER ?? '/org/bluez/hci0',
    // нет пакетов дольше этого — перезапускаем discovery
    watchdogMs: num('HUMIDOR_WATCHDOG_SEC', 120) * 1000,
    retentionDays: num('HUMIDOR_RETENTION_DAYS', 365),
  };
}

export function telegramConfig() {
  const chatIds = required('TELEGRAM_CHAT_IDS')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
  if (chatIds.length === 0) throw new Error('env TELEGRAM_CHAT_IDS has no valid ids');
  return {
    ...commonConfig(),
    token: required('TELEGRAM_BOT_TOKEN'),
    chatIds,
  };
}

export function thresholdsConfig() {
  return {
    humLow: num('HUM_LOW', 62),
    humHigh: num('HUM_HIGH', 73),
    humHyst: num('HUM_HYST', 1.5),
    humForMs: num('HUM_FOR_MIN', 30) * 60_000,
    tempHigh: num('TEMP_HIGH', 25),
    tempHyst: num('TEMP_HYST', 0.5),
    tempForMs: num('TEMP_FOR_MIN', 15) * 60_000,
    staleMs: num('STALE_MIN', 15) * 60_000,
    battLowV: num('BATT_LOW_V', 2.5),
    remindMs: num('REMIND_HOURS', 6) * 3_600_000,
  };
}

export type Thresholds = ReturnType<typeof thresholdsConfig>;
