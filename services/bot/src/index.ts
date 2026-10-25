import { Bot } from 'grammy';
import {
  Store,
  ago,
  clock,
  fmt,
  logger,
  sparkline,
  telegramConfig,
} from '@humidor/core';

const log = logger('bot');
const tg = telegramConfig();
const store = new Store(tg.dbPath);
const allowed = new Set(tg.chatIds);
const bot = new Bot(tg.token);

const ALERT_NAMES: Record<string, string> = {
  stale: 'нет данных от датчика',
  humidity_high: 'влажность выше нормы',
  humidity_low: 'влажность ниже нормы',
  temperature_high: 'температура выше нормы',
  battery_low: 'батарея садится',
};

// Бот публичный: отвечаем только своим чатам, остальных молча игнорируем
bot.use(async (ctx, next) => {
  const id = ctx.chat?.id;
  if (id === undefined || !allowed.has(id)) {
    log.warn(`ignored update from chat ${id}`);
    return;
  }
  await next();
});

function parseRange(arg: string): number {
  const m = /^(\d+)\s*([hd])$/i.exec(arg.trim());
  if (!m) return 24 * 3_600_000;
  const n = Number(m[1]);
  const ms = m[2]!.toLowerCase() === 'd' ? n * 86_400_000 : n * 3_600_000;
  return Math.min(Math.max(ms, 3_600_000), 30 * 86_400_000);
}

const HELP = [
  '/now — текущие показания',
  '/status — батарея, сигнал, активные алерты',
  '/history [6h|24h|7d] — статистика и тренд',
].join('\n');

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));

bot.command('now', async (ctx) => {
  const r = store.latestClimate();
  if (!r) return ctx.reply('Данных пока нет');
  await ctx.reply(
    `🌡 ${fmt(r.temperature, 2)} °C\n💧 ${fmt(r.humidity, 2)} %\nобновлено ${ago(r.ts)}`,
  );
});

bot.command('status', async (ctx) => {
  const now = Date.now();
  const v = store.latestVoltage();
  const battery = store.latestBattery();
  const r = store.latestClimate();
  const active = store.activeAlerts();
  const lines = [
    `📡 последний пакет: ${ago(store.lastSeen(), now)}`,
    `📶 RSSI: ${r?.rssi ?? '—'} dBm`,
    `🔋 батарея: ${fmt(v?.voltage, 3)} В (${battery ?? '—'} %)`,
    `📦 пакетов за 24 ч: ${store.countSince(now - 86_400_000)}`,
    '',
    active.length === 0
      ? '✅ активных алертов нет'
      : '🔴 активные алерты:\n' +
        active.map((a) => `• ${ALERT_NAMES[a.name] ?? a.name} (с ${a.since ? clock(a.since) : '?'})`).join('\n'),
  ];
  await ctx.reply(lines.join('\n'));
});

bot.command('history', async (ctx) => {
  const rangeMs = parseRange(ctx.match || '24h');
  const since = Date.now() - rangeMs;
  const s = store.stats(since);
  if (s.n === 0) return ctx.reply('За этот период данных нет');

  const buckets = store.buckets(since, Math.ceil(rangeMs / 24));
  const hours = rangeMs / 3_600_000;
  const label = hours >= 48 ? `${Math.round(hours / 24)} д` : `${Math.round(hours)} ч`;
  await ctx.reply(
    [
      `📈 за ${label} (${s.n} измерений)`,
      '',
      `💧 ${fmt(s.hMin)}…${fmt(s.hMax)} %, ср. ${fmt(s.hAvg)}`,
      sparkline(buckets.map((b) => b.h)),
      '',
      `🌡 ${fmt(s.tMin)}…${fmt(s.tMax)} °C, ср. ${fmt(s.tAvg)}`,
      sparkline(buckets.map((b) => b.t)),
    ].join('\n'),
  );
});

bot.catch((err) => log.error('handler error:', err.error));

const shutdown = async () => {
  await bot.stop();
  store.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await bot.api.setMyCommands([
  { command: 'now', description: 'Текущие показания' },
  { command: 'status', description: 'Батарея, сигнал, алерты' },
  { command: 'history', description: 'Статистика: 6h, 24h, 7d' },
]);
await bot.start({ onStart: (me) => log.info(`polling as @${me.username}`) });
