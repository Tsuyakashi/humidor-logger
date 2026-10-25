import { type Store, type Thresholds, fmt } from '@humidor/core';

// Правило: условие срабатывания + отдельное условие сброса (гистерезис),
// иначе на границе порога алерт будет флапать.

export interface RuleContext {
  now: number;
  store: Store;
  t: Thresholds;
  stale: boolean;
}

export interface Rule {
  name: string;
  title: string;
  shouldFire(ctx: RuleContext): boolean;
  shouldResolve(ctx: RuleContext): boolean;
  details(ctx: RuleContext): string;
}

const climateLine = (ctx: RuleContext) => {
  const last = ctx.store.latestClimate();
  return last ? `Сейчас: ${fmt(last.temperature, 2)} °C, ${fmt(last.humidity, 2)} %` : 'Нет данных';
};

export const rules: Rule[] = [
  {
    name: 'stale',
    title: 'Нет данных от датчика',
    shouldFire: (ctx) => ctx.stale,
    shouldResolve: (ctx) => !ctx.stale,
    details: (ctx) => {
      const seen = ctx.store.lastSeen();
      return seen ? `Последний пакет ${Math.round((ctx.now - seen) / 60_000)} мин назад` : 'Пакетов не было';
    },
  },
  {
    name: 'humidity_high',
    title: 'Влажность выше нормы',
    shouldFire: (ctx) => {
      if (ctx.stale) return false;
      const w = ctx.store.stats(ctx.now - ctx.t.humForMs);
      return w.n >= 3 && w.hMin !== null && w.hMin > ctx.t.humHigh;
    },
    shouldResolve: (ctx) => {
      const h = ctx.store.latestClimate()?.humidity;
      return h != null && h < ctx.t.humHigh - ctx.t.humHyst;
    },
    details: (ctx) => `${climateLine(ctx)}\nПорог: > ${ctx.t.humHigh} % дольше ${ctx.t.humForMs / 60_000} мин`,
  },
  {
    name: 'humidity_low',
    title: 'Влажность ниже нормы',
    shouldFire: (ctx) => {
      if (ctx.stale) return false;
      const w = ctx.store.stats(ctx.now - ctx.t.humForMs);
      return w.n >= 3 && w.hMax !== null && w.hMax < ctx.t.humLow;
    },
    shouldResolve: (ctx) => {
      const h = ctx.store.latestClimate()?.humidity;
      return h != null && h > ctx.t.humLow + ctx.t.humHyst;
    },
    details: (ctx) => `${climateLine(ctx)}\nПорог: < ${ctx.t.humLow} % дольше ${ctx.t.humForMs / 60_000} мин`,
  },
  {
    name: 'temperature_high',
    title: 'Температура выше нормы',
    shouldFire: (ctx) => {
      if (ctx.stale) return false;
      const w = ctx.store.stats(ctx.now - ctx.t.tempForMs);
      return w.n >= 3 && w.tMin !== null && w.tMin > ctx.t.tempHigh;
    },
    shouldResolve: (ctx) => {
      const t = ctx.store.latestClimate()?.temperature;
      return t != null && t < ctx.t.tempHigh - ctx.t.tempHyst;
    },
    details: (ctx) => `${climateLine(ctx)}\nПорог: > ${ctx.t.tempHigh} °C дольше ${ctx.t.tempForMs / 60_000} мин`,
  },
  {
    name: 'battery_low',
    title: 'Батарея датчика садится',
    shouldFire: (ctx) => {
      const v = ctx.store.latestVoltage();
      return v !== null && v.voltage < ctx.t.battLowV;
    },
    shouldResolve: (ctx) => {
      const v = ctx.store.latestVoltage();
      return v !== null && v.voltage > ctx.t.battLowV + 0.1;
    },
    details: (ctx) => `Напряжение: ${fmt(ctx.store.latestVoltage()?.voltage, 3)} В (порог ${ctx.t.battLowV} В)`,
  },
];
