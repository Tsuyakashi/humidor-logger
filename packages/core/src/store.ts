import { DatabaseSync } from 'node:sqlite';

// Общий SQLite (WAL). Пишут collector (readings) и alerter (alerts),
// bot только читает. busy_timeout закрывает конкуренцию за lock.

export interface Reading {
  ts: number; // ms epoch
  packetId: number | null;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
  voltage: number | null;
  rssi: number | null;
}

export interface WindowStats {
  n: number;
  tMin: number | null;
  tMax: number | null;
  tAvg: number | null;
  hMin: number | null;
  hMax: number | null;
  hAvg: number | null;
}

export interface Bucket {
  b: number;
  t: number;
  h: number;
}

export interface AlertState {
  name: string;
  active: boolean;
  since: number | null;
  lastNotified: number | null;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS readings (
  ts          INTEGER NOT NULL,
  packet_id   INTEGER,
  temperature REAL,
  humidity    REAL,
  battery     INTEGER,
  voltage     REAL,
  rssi        INTEGER
);
CREATE INDEX IF NOT EXISTS readings_ts ON readings(ts);
CREATE TABLE IF NOT EXISTS alerts (
  name          TEXT PRIMARY KEY,
  active        INTEGER NOT NULL DEFAULT 0,
  since         INTEGER,
  last_notified INTEGER
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insert(r: Reading): void {
    this.db
      .prepare(
        `INSERT INTO readings (ts, packet_id, temperature, humidity, battery, voltage, rssi)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.ts, r.packetId, r.temperature, r.humidity, r.battery, r.voltage, r.rssi);
  }

  prune(before: number): number {
    const res = this.db.prepare('DELETE FROM readings WHERE ts < ?').run(before);
    return Number(res.changes);
  }

  lastSeen(): number | null {
    const row = this.db.prepare('SELECT max(ts) AS ts FROM readings').get() as Row | undefined;
    return (row?.ts as number | null) ?? null;
  }

  latestClimate(): Reading | null {
    const row = this.db
      .prepare(
        `SELECT * FROM readings WHERE temperature IS NOT NULL AND humidity IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as Row | undefined;
    return row ? toReading(row) : null;
  }

  latestVoltage(): { ts: number; voltage: number } | null {
    const row = this.db
      .prepare('SELECT ts, voltage FROM readings WHERE voltage IS NOT NULL ORDER BY ts DESC LIMIT 1')
      .get() as Row | undefined;
    return row ? { ts: row.ts as number, voltage: row.voltage as number } : null;
  }

  latestBattery(): number | null {
    const row = this.db
      .prepare('SELECT battery FROM readings WHERE battery IS NOT NULL ORDER BY ts DESC LIMIT 1')
      .get() as Row | undefined;
    return (row?.battery as number | null) ?? null;
  }

  countSince(since: number): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM readings WHERE ts >= ?').get(since) as Row;
    return Number(row.n);
  }

  stats(since: number): WindowStats {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n,
                min(temperature) AS tMin, max(temperature) AS tMax, avg(temperature) AS tAvg,
                min(humidity) AS hMin, max(humidity) AS hMax, avg(humidity) AS hAvg
         FROM readings WHERE ts >= ? AND temperature IS NOT NULL AND humidity IS NOT NULL`,
      )
      .get(since) as Row;
    return {
      n: Number(row.n),
      tMin: row.tMin as number | null,
      tMax: row.tMax as number | null,
      tAvg: row.tAvg as number | null,
      hMin: row.hMin as number | null,
      hMax: row.hMax as number | null,
      hAvg: row.hAvg as number | null,
    };
  }

  buckets(since: number, bucketMs: number): Bucket[] {
    bucketMs = Math.max(1, bucketMs);
    // node:sqlite биндит JS-числа как REAL, деление получается дробным — приводим к номеру бакета
    const rows = this.db
      .prepare(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b, avg(temperature) AS t, avg(humidity) AS h
         FROM readings WHERE ts >= ? AND temperature IS NOT NULL AND humidity IS NOT NULL
         GROUP BY b ORDER BY b`,
      )
      .all(since, bucketMs, since) as Row[];
    return rows.map((r) => ({ b: Number(r.b), t: r.t as number, h: r.h as number }));
  }

  getAlert(name: string): AlertState {
    const row = this.db.prepare('SELECT * FROM alerts WHERE name = ?').get(name) as Row | undefined;
    if (!row) return { name, active: false, since: null, lastNotified: null };
    return {
      name,
      active: Number(row.active) === 1,
      since: row.since as number | null,
      lastNotified: row.last_notified as number | null,
    };
  }

  activeAlerts(): AlertState[] {
    const rows = this.db.prepare('SELECT * FROM alerts WHERE active = 1 ORDER BY since').all() as Row[];
    return rows.map((r) => ({
      name: r.name as string,
      active: true,
      since: r.since as number | null,
      lastNotified: r.last_notified as number | null,
    }));
  }

  setAlert(s: AlertState): void {
    this.db
      .prepare(
        `INSERT INTO alerts (name, active, since, last_notified) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET active = excluded.active, since = excluded.since,
           last_notified = excluded.last_notified`,
      )
      .run(s.name, s.active ? 1 : 0, s.since, s.lastNotified);
  }
}

function toReading(r: Row): Reading {
  return {
    ts: r.ts as number,
    packetId: r.packet_id as number | null,
    temperature: r.temperature as number | null,
    humidity: r.humidity as number | null,
    battery: r.battery as number | null,
    voltage: r.voltage as number | null,
    rssi: r.rssi as number | null,
  };
}
