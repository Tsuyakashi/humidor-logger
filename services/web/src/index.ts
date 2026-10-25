import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, logger, webConfig } from '@humidor/core';

// Публичная страница с графиком. Слушает только loopback, наружу — через Tailscale Funnel,
// поэтому всё, что приходит снаружи, ограничено whitelist'ом: методы, пути, range.

const log = logger('web');
const cfg = webConfig();
const store = new Store(cfg.dbPath);

const RANGES: Record<string, number> = {
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};
const POINTS = 200;
const CACHE_MS = 30_000;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  'X-Frame-Options': 'DENY',
};

interface Payload {
  status: number;
  type?: string;
  body?: Buffer;
  cache?: string;
}

// Статика читается один раз при старте: отдаём только эти файлы
const PUBLIC = new URL('./public/', import.meta.url);
const STATIC: Record<string, Payload> = {};
for (const [path, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/uplot.min.js', 'uplot.min.js', 'text/javascript; charset=utf-8'],
  ['/uplot.min.css', 'uplot.min.css', 'text/css; charset=utf-8'],
] as const) {
  STATIC[path] = { status: 200, type, body: readFileSync(new URL(file, PUBLIC)), cache: 'no-cache' };
}

const round = (v: number) => Math.round(v * 100) / 100;

function json(data: unknown): Payload {
  return {
    status: 200,
    type: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(data)),
    cache: `public, max-age=${CACHE_MS / 1000}`,
  };
}

function apiNow(): Payload {
  const r = store.latestClimate();
  if (!r) return { status: 204 };
  return json({ ts: r.ts, temperature: r.temperature, humidity: r.humidity });
}

function apiSeries(range: string): Payload {
  const rangeMs = RANGES[range]!;
  const to = Date.now();
  const from = to - rangeMs;
  const bucketMs = rangeMs / POINTS;
  // b === POINTS — запись, вставленная уже после `to`
  const points = store.buckets(from, bucketMs).filter((b) => b.b < POINTS).map((b) => ({
    ts: Math.round(from + (b.b + 0.5) * bucketMs), // середина бакета
    t: round(b.t),
    h: round(b.h),
  }));
  return json({ range, from, to, bucketMs, rhBand: cfg.rhBand, points });
}

// Ключи только из whitelist, так что кэш ограничен по размеру сам собой
const cache = new Map<string, { exp: number; payload: Payload }>();

function cached(key: string, build: () => Payload): Payload {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.payload;
  const payload = build();
  cache.set(key, { exp: now + CACHE_MS, payload });
  return payload;
}

function route(req: IncomingMessage): Payload {
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405 };
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return { status: 400 };
  }

  const file = STATIC[url.pathname];
  if (file) return file;

  if (url.pathname === '/api/now') return cached('/api/now', apiNow);
  if (url.pathname === '/api/series') {
    const range = url.searchParams.get('range') ?? '24h';
    if (!Object.hasOwn(RANGES, range)) return { status: 400 };
    return cached(`/api/series?${range}`, () => apiSeries(range));
  }
  return { status: 404 };
}

function send(req: IncomingMessage, res: ServerResponse, p: Payload): void {
  const headers: Record<string, string | number> = { ...SECURITY_HEADERS };
  if (p.status === 405) headers.Allow = 'GET, HEAD';
  if (p.body) {
    headers['Content-Type'] = p.type!;
    headers['Content-Length'] = p.body.length;
    headers['Cache-Control'] = p.cache ?? 'no-store';
    res.writeHead(p.status, headers);
    res.end(req.method === 'HEAD' ? undefined : p.body);
    return;
  }
  // ошибки и 204 — без тела, чтобы не светить детали
  res.writeHead(p.status, headers);
  res.end();
}

const server = createServer((req, res) => {
  try {
    send(req, res, route(req));
  } catch (err) {
    log.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) send(req, res, { status: 500 });
    else res.destroy();
  }
});

const shutdown = () => {
  log.info('shutting down');
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(cfg.port, cfg.host, () => log.info(`listening on http://${cfg.host}:${cfg.port}`));
