const BLOCKS = '▁▂▃▄▅▆▇█';

const GAP = '·';

// null — пустой слот (нет данных), рисуется точкой
export function sparkline(values: (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return GAP.repeat(values.length);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min;
  return values
    .map((v) => {
      if (v === null) return GAP;
      return span === 0 ? BLOCKS[3] : BLOCKS[Math.round(((v - min) / span) * (BLOCKS.length - 1))];
    })
    .join('');
}

export function ago(ts: number | null, now = Date.now()): string {
  if (ts === null) return 'никогда';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин назад`;
  return `${Math.floor(h / 24)} д назад`;
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

export function fmt(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { hour12: false });
}
