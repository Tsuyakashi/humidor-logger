import { Api } from 'grammy';
import { Store, duration, logger, telegramConfig, thresholdsConfig } from '@humidor/core';
import { type RuleContext, rules } from './rules.js';

const log = logger('alerter');
const tg = telegramConfig();
const t = thresholdsConfig();
const store = new Store(tg.dbPath);
// только sendMessage, без getUpdates — не конфликтует с long polling бота на том же токене
const api = new Api(tg.token);

const TICK_MS = 60_000;

async function notify(text: string): Promise<void> {
  for (const chatId of tg.chatIds) await api.sendMessage(chatId, text);
}

async function tick(): Promise<void> {
  const now = Date.now();
  const lastSeen = store.lastSeen();
  const ctx: RuleContext = {
    now,
    store,
    t,
    stale: lastSeen === null || now - lastSeen > t.staleMs,
  };

  for (const rule of rules) {
    const state = store.getAlert(rule.name);
    try {
      if (!state.active && rule.shouldFire(ctx)) {
        await notify(`🔴 ${rule.title}\n${rule.details(ctx)}`);
        store.setAlert({ name: rule.name, active: true, since: now, lastNotified: now });
        log.info(`fired ${rule.name}`);
      } else if (state.active && rule.shouldResolve(ctx)) {
        const lasted = state.since ? `\nДлилось: ${duration(now - state.since)}` : '';
        await notify(`🟢 Норма: ${rule.title.toLowerCase()}${lasted}\n${rule.details(ctx)}`);
        store.setAlert({ name: rule.name, active: false, since: null, lastNotified: now });
        log.info(`resolved ${rule.name}`);
      } else if (state.active && now - (state.lastNotified ?? 0) > t.remindMs) {
        const lasted = state.since ? ` уже ${duration(now - state.since)}` : '';
        await notify(`🟠 Всё ещё: ${rule.title.toLowerCase()}${lasted}\n${rule.details(ctx)}`);
        store.setAlert({ ...state, lastNotified: now });
      }
    } catch (err) {
      // не смогли отправить — состояние не трогаем, повторим на следующем тике
      log.error(`rule ${rule.name}:`, err);
    }
  }
}

let running = false;
const loop = async () => {
  if (running) return;
  running = true;
  try {
    await tick();
  } finally {
    running = false;
  }
};

const timer = setInterval(loop, TICK_MS);
void loop();
log.info(`started, ${rules.length} rules, tick ${TICK_MS / 1000}s`);

const shutdown = () => {
  clearInterval(timer);
  store.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
