import dbus from 'dbus-next';
import type { Variant as DbusVariant, Message as DbusMessage } from 'dbus-next';

// BLE через BlueZ D-Bus API хоста (сокет проброшен в CT, см. scripts/host-setup.sh).
// Raw HCI в unprivileged LXC недоступен, поэтому noble и аналоги не подходят.

const { Message, Variant, MessageType } = dbus;

const BLUEZ = 'org.bluez';
const ADAPTER_IFACE = 'org.bluez.Adapter1';
const DEVICE_IFACE = 'org.bluez.Device1';

export interface Advertisement {
  rssi: number | null;
  serviceData: Record<string, Buffer>;
}

export class BleScanner {
  private bus = dbus.systemBus();
  private readonly devPath: string;
  private lastRssi: number | null = null;

  constructor(
    private readonly adapterPath: string,
    mac: string,
    private readonly onAdv: (adv: Advertisement) => void,
    private readonly onFatal: (err: unknown) => void,
  ) {
    this.devPath = `${adapterPath}/dev_${mac.toUpperCase().replace(/:/g, '_')}`;
    // упала шина (рестарт dbus на хосте и т.п.) — пусть systemd перезапустит процесс
    this.bus.on('error', (err: unknown) => this.onFatal(err));
    this.bus.on('message', (msg: DbusMessage) => this.handle(msg));
  }

  async start(): Promise<void> {
    await this.addMatch(
      `type='signal',sender='${BLUEZ}',path='${this.devPath}',` +
        `interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'`,
    );
    // BlueZ удаляет неспаренные устройства по таймауту и потом добавляет заново
    await this.addMatch(
      `type='signal',sender='${BLUEZ}',path='/',` +
        `interface='org.freedesktop.DBus.ObjectManager',member='InterfacesAdded'`,
    );
    await this.startDiscovery();
  }

  async restart(): Promise<void> {
    try {
      await this.callBluez(this.adapterPath, ADAPTER_IFACE, 'StopDiscovery', '', []);
    } catch {
      // не было активного discovery — ок
    }
    await this.startDiscovery();
  }

  async stop(): Promise<void> {
    try {
      await this.callBluez(this.adapterPath, ADAPTER_IFACE, 'StopDiscovery', '', []);
    } catch {
      // ignore
    }
    this.bus.disconnect();
  }

  private async startDiscovery(): Promise<void> {
    await this.callBluez(this.adapterPath, ADAPTER_IFACE, 'SetDiscoveryFilter', 'a{sv}', [
      {
        Transport: new Variant('s', 'le'),
        DuplicateData: new Variant('b', true),
      },
    ]);
    try {
      await this.callBluez(this.adapterPath, ADAPTER_IFACE, 'StartDiscovery', '', []);
    } catch (err) {
      if (!String(err).includes('InProgress')) throw err;
    }
  }

  private handle(msg: DbusMessage): void {
    if (msg.type !== MessageType.SIGNAL) return;

    if (msg.member === 'PropertiesChanged' && msg.path === this.devPath) {
      const [iface, changed] = msg.body as [string, Record<string, DbusVariant>];
      if (iface === DEVICE_IFACE) this.handleProps(changed);
      return;
    }

    if (msg.member === 'InterfacesAdded') {
      const [path, ifaces] = msg.body as [string, Record<string, Record<string, DbusVariant>>];
      const props = path === this.devPath ? ifaces[DEVICE_IFACE] : undefined;
      if (props) this.handleProps(props);
    }
  }

  private handleProps(props: Record<string, DbusVariant>): void {
    const rssi = props.RSSI;
    if (rssi) this.lastRssi = Number(rssi.value);

    const sd = props.ServiceData;
    if (!sd) return;
    const raw = sd.value as Record<string, DbusVariant>;
    const serviceData: Record<string, Buffer> = {};
    for (const [uuid, v] of Object.entries(raw)) serviceData[uuid.toLowerCase()] = Buffer.from(v.value as Buffer);
    this.onAdv({ rssi: this.lastRssi, serviceData });
  }

  private async addMatch(rule: string): Promise<void> {
    await this.bus.call(
      new Message({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'AddMatch',
        signature: 's',
        body: [rule],
      }),
    );
  }

  private async callBluez(
    path: string,
    iface: string,
    member: string,
    signature: string,
    body: unknown[],
  ): Promise<void> {
    await this.bus.call(new Message({ destination: BLUEZ, path, interface: iface, member, signature, body }));
  }
}
