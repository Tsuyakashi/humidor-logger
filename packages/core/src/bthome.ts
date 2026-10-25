// Минимальный парсер BTHome v2 (незашифрованный), под то, что шлёт pvvx.
// Формат: [device info][obj id][value]...; длина value определяется только по id,
// поэтому на неизвестном id разбор останавливается.

export const BTHOME_UUID = '0000fcd2-0000-1000-8000-00805f9b34fb';

export interface BthomeReading {
  packetId?: number;
  battery?: number;
  temperature?: number;
  humidity?: number;
  voltage?: number;
}

interface ObjDef {
  key: keyof BthomeReading | null; // null — знаем длину, но значение не нужно
  size: 1 | 2;
  signed: boolean;
  factor: number;
}

const OBJECTS: Record<number, ObjDef> = {
  0x00: { key: 'packetId', size: 1, signed: false, factor: 1 },
  0x01: { key: 'battery', size: 1, signed: false, factor: 1 },
  0x02: { key: 'temperature', size: 2, signed: true, factor: 0.01 },
  0x03: { key: 'humidity', size: 2, signed: false, factor: 0.01 },
  0x0c: { key: 'voltage', size: 2, signed: false, factor: 0.001 },
  0x0f: { key: null, size: 1, signed: false, factor: 1 }, // generic boolean
  0x10: { key: null, size: 1, signed: false, factor: 1 }, // power
  0x11: { key: null, size: 1, signed: false, factor: 1 }, // opening
  0x2e: { key: null, size: 1, signed: false, factor: 1 }, // humidity uint8
  0x45: { key: null, size: 2, signed: true, factor: 0.1 }, // temperature 0.1
};

export function parseBthome(buf: Uint8Array): BthomeReading | null {
  if (buf.length < 2) return null;
  const info = buf[0]!;
  if (info & 0x01) return null; // encrypted
  if (((info >> 5) & 0x07) !== 2) return null; // only v2

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: BthomeReading = {};
  let i = 1;
  while (i < buf.length) {
    const def = OBJECTS[buf[i]!];
    if (!def) break;
    const off = i + 1;
    if (off + def.size > buf.length) break;
    if (def.key) {
      const raw =
        def.size === 1
          ? def.signed ? view.getInt8(off) : view.getUint8(off)
          : def.signed ? view.getInt16(off, true) : view.getUint16(off, true);
      out[def.key] = Math.round(raw * def.factor * 1000) / 1000;
    }
    i = off + def.size;
  }
  return out;
}
