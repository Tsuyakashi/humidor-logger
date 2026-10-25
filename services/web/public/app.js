// Страница хьюмидора: текущие показания + график uPlot. Без сборки, обычный браузерный JS.
'use strict';

const RANGES = ['6h', '24h', '7d', '30d'];
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);
const chartEl = $('chart');
const emptyEl = $('empty');
const dark = matchMedia('(prefers-color-scheme: dark)');

let range = RANGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : '24h';
let lastTs = null;
let series = null;
let plot = null;

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин назад`;
  return `${Math.floor(h / 24)} д назад`;
}

function renderUpdated() {
  $('updated').textContent = lastTs === null ? 'данных пока нет' : `обновлено ${ago(lastTs)}`;
}

async function loadNow() {
  const res = await fetch('/api/now');
  if (res.status === 204) {
    lastTs = null;
  } else if (res.ok) {
    const d = await res.json();
    lastTs = d.ts;
    $('temp').textContent = d.temperature == null ? '—' : d.temperature.toFixed(1);
    $('hum').textContent = d.humidity == null ? '—' : d.humidity.toFixed(1);
  }
  renderUpdated();
}

// Пропуски длиннее двух бакетов разрываем null'ом, иначе uPlot соединит их линией
function toData(d) {
  const xs = [], ts = [], hs = [];
  let prev = null;
  for (const p of d.points) {
    if (prev !== null && p.ts - prev > d.bucketMs * 2) {
      xs.push((prev + d.bucketMs) / 1000);
      ts.push(null);
      hs.push(null);
    }
    xs.push(p.ts / 1000);
    ts.push(p.t);
    hs.push(p.h);
    prev = p.ts;
  }
  return [xs, ts, hs];
}

function bandPlugin(band) {
  return {
    hooks: {
      drawClear: (u) => {
        const { ctx, bbox } = u;
        const y1 = u.valToPos(band[1], 'h', true);
        const y0 = u.valToPos(band[0], 'h', true);
        ctx.save();
        ctx.fillStyle = css('--band');
        ctx.fillRect(bbox.left, y1, bbox.width, y0 - y1);
        ctx.restore();
      },
    },
  };
}

function chartSize() {
  const width = chartEl.clientWidth;
  const height = Math.round(Math.min(Math.max(window.innerHeight * 0.5, 260), 440));
  return { width, height };
}

function render() {
  if (plot) {
    plot.destroy();
    plot = null;
  }
  if (!series || series.points.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  const band = series.rhBand;
  const fg = css('--muted');
  const grid = { stroke: css('--grid'), width: 1 };
  const ticks = { stroke: css('--grid'), width: 1 };
  const fmt = (unit) => (u, v) => (v == null ? '—' : `${v.toFixed(1)} ${unit}`);

  plot = new uPlot(
    {
      ...chartSize(),
      plugins: [bandPlugin(band)],
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { time: true, range: () => [series.from / 1000, series.to / 1000] },
        t: { auto: true },
        // коридор RH всегда в кадре
        h: { range: (u, min, max) => [Math.floor(Math.min(min ?? band[0], band[0]) - 1), Math.ceil(Math.max(max ?? band[1], band[1]) + 1)] },
      },
      axes: [
        { stroke: fg, grid, ticks },
        { scale: 't', stroke: css('--temp'), grid, ticks, values: (u, vals) => vals.map((v) => `${v}°`) },
        { scale: 'h', side: 1, stroke: css('--hum'), grid: { show: false }, ticks, values: (u, vals) => vals.map((v) => `${v}%`) },
      ],
      series: [
        {},
        { label: 'Температура', scale: 't', stroke: css('--temp'), width: 2, value: fmt('°C') },
        { label: 'Влажность', scale: 'h', stroke: css('--hum'), width: 2, value: fmt('%') },
      ],
    },
    toData(series),
    chartEl,
  );
}

async function loadSeries() {
  const res = await fetch(`/api/series?range=${range}`);
  if (!res.ok) throw new Error(`series: HTTP ${res.status}`);
  series = await res.json();
  render();
}

function selectRange(r) {
  range = r;
  history.replaceState(null, '', `#${r}`);
  for (const b of document.querySelectorAll('#ranges button')) {
    b.setAttribute('aria-pressed', String(b.dataset.range === r));
  }
  loadSeries().catch(console.error);
}

async function refresh() {
  await Promise.all([loadNow(), loadSeries()]).catch(console.error);
}

$('ranges').addEventListener('click', (e) => {
  const r = e.target.closest('button')?.dataset.range;
  if (r && r !== range) selectRange(r);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => plot?.setSize(chartSize()), 100);
});
// цвета осей и линий берутся из CSS при создании — пересоздаём график при смене темы
dark.addEventListener('change', render);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

selectRange(range);
loadNow().catch(console.error);
setInterval(refresh, REFRESH_MS);
setInterval(renderUpdated, 1000);
