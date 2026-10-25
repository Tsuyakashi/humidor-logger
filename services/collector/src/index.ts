import { BTHOME_UUID, Store, collectorConfig, logger, parseBthome } from '@humidor/core';
import { BleScanner } from './ble.js';

const log = logger('collector');
const cfg = collectorConfig();
const store = new Store(cfg.dbPath);

// после рестарта не пишем повтор последнего пакета
let lastPacketId: number | null = store.lastPacketId();
let lastAdvAt = Date.now();
let restarting = false;

const fatal = (err: unknown) => {
  log.error('fatal:', err);
  process.exit(1);
};

const scanner = new BleScanner(
  cfg.adapterPath,
  cfg.mac,
  ({ rssi, serviceData }) => {
    const data = serviceData[BTHOME_UUID];
    if (!data) return;
    lastAdvAt = Date.now();

    const r = parseBthome(data);
    // pvvx повторяет один пакет много раз — пишем только новый packet_id
    if (!r || r.packetId === undefined || r.packetId === lastPacketId) return;
    lastPacketId = r.packetId;

    store.insert({
      ts: Date.now(),
      packetId: r.packetId,
      temperature: r.temperature ?? null,
      humidity: r.humidity ?? null,
      battery: r.battery ?? null,
      voltage: r.voltage ?? null,
      rssi,
    });
  },
  fatal,
);

// Watchdog: BLE-скан иногда «засыпает» (рестарт bluetoothd на хосте, сброс адаптера)
setInterval(async () => {
  if (restarting || Date.now() - lastAdvAt < cfg.watchdogMs) return;
  restarting = true;
  log.warn(`no advertisements for ${Math.round((Date.now() - lastAdvAt) / 1000)}s, restarting discovery`);
  try {
    await scanner.restart();
    lastAdvAt = Date.now();
  } catch (err) {
    fatal(err);
  } finally {
    restarting = false;
  }
}, 30_000);

// Ретенция раз в час
setInterval(() => {
  const removed = store.prune(Date.now() - cfg.retentionDays * 86_400_000);
  if (removed > 0) log.info(`pruned ${removed} old readings`);
}, 3_600_000);

const shutdown = async () => {
  log.info('shutting down');
  await scanner.stop();
  store.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

scanner
  .start()
  .then(() => log.info(`scanning for ${cfg.mac} via ${cfg.adapterPath}`))
  .catch(fatal);
