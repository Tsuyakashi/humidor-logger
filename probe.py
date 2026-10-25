import asyncio
import struct
from datetime import datetime

from bleak import BleakScanner

MAC = "A4:C1:38:1D:96:98"
BTHOME_UUID = "0000fcd2-0000-1000-8000-00805f9b34fb"

# BTHome v2 object id -> (name, struct fmt, factor)
OBJECTS = {
    0x00: ("packet_id", "<B", 1),
    0x01: ("battery", "<B", 1),
    0x02: ("temperature", "<h", 0.01),
    0x03: ("humidity", "<H", 0.01),
    0x0C: ("voltage", "<H", 0.001),
    0x0F: ("generic_bool", "<B", 1),
    0x10: ("power", "<B", 1),
    0x11: ("opening", "<B", 1),
    0x2E: ("humidity_int", "<B", 1),
    0x45: ("temperature_01", "<h", 0.1),
}

last_pid = None


def parse_bthome(data: bytes) -> dict:
    if not data:
        return {}
    info = data[0]
    if info & 0x01:                      # encrypted, не наш случай
        return {}
    if (info >> 5) & 0x07 != 2:          # только BTHome v2
        return {}
    out, i = {}, 1
    while i < len(data):
        obj = OBJECTS.get(data[i])
        if obj is None:                  # неизвестный id: длину не знаем, дальше парсить нельзя
            break
        name, fmt, factor = obj
        size = struct.calcsize(fmt)
        raw = data[i + 1 : i + 1 + size]
        if len(raw) < size:
            break
        (val,) = struct.unpack(fmt, raw)
        out[name] = round(val * factor, 3) if factor != 1 else val
        i += 1 + size
    return out


def cb(dev, adv):
    global last_pid
    if dev.address.upper() != MAC:
        return
    data = adv.service_data.get(BTHOME_UUID)
    if data is None:
        return
    vals = parse_bthome(bytes(data))
    pid = vals.get("packet_id")
    if not vals or pid == last_pid:      # повторы одного пакета отбрасываем
        return
    last_pid = pid
    print(datetime.now().strftime("%H:%M:%S"), adv.rssi, vals, flush=True)


async def main():
    async with BleakScanner(cb):
        await asyncio.sleep(900)

asyncio.run(main())
