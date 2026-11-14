// Робота з платою через Web Serial: прошивання (esptool-js) і обмін рядками за docs/PROTOCOL.md, розділ 6.
import { ESPLoader, Transport } from "esptool-js";

export const ESPRESSIF_VID = 0x303a;

export function serialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FlashCallbacks {
  log: (text: string) => void;
  progress: (pct: number) => void;
}

/** Підключається завантажувачем і повертає назву чипа у вигляді esp32s3 / esp32c3. */
export async function detectChip(port: SerialPort, cb: FlashCallbacks): Promise<{ chip: string; loader: ESPLoader; transport: Transport }> {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    romBaudrate: 115200,
    terminal: {
      clean: () => {},
      writeLine: (d: string) => cb.log(d),
      write: () => {},
    },
  });
  await loader.main();
  const name = loader.chip.CHIP_NAME; // "ESP32-S3", "ESP32-C3"
  const chip = name.toLowerCase().replace(/-/g, "");
  return { chip, loader, transport };
}

export async function flashImage(loader: ESPLoader, data: Uint8Array, eraseAll: boolean, cb: FlashCallbacks) {
  await loader.writeFlash({
    fileArray: [{ data, address: 0 }],
    flashMode: "keep",
    flashFreq: "keep",
    flashSize: "keep",
    eraseAll,
    compress: true,
    reportProgress: (_i: number, written: number, total: number) => cb.progress(Math.floor((written / total) * 100)),
  });
}

export async function resetAndClose(loader: ESPLoader, transport: Transport) {
  try {
    await loader.after("hard_reset");
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

/** Після перезапуску USB Serial/JTAG плата підключається заново: шукаємо той самий порт серед дозволених. */
export async function reopenPort(old: SerialPort, timeoutMs = 20000): Promise<SerialPort> {
  const info = old.getInfo();
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    const candidates = [old, ...(await navigator.serial.getPorts()).filter((p) => p !== old)];
    for (const p of candidates) {
      const pi = p.getInfo();
      if (p !== old && (pi.usbVendorId !== info.usbVendorId || pi.usbProductId !== info.usbProductId)) continue;
      try {
        await p.open({ baudRate: 115200 });
        return p;
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(700);
  }
  throw new Error("Не вдалося знову відкрити порт після перезапуску плати" + (lastErr ? `: ${lastErr}` : ""));
}

/** Рядковий обмін із прошивкою модуля. Порт має бути вже відкритий. */
export class LineLink {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buf = "";
  private replies: any[] = [];
  private waiters: ((v: any) => void)[] = [];
  private closed = false;
  private decoder = new TextDecoder();

  constructor(private port: SerialPort, private onLog: (line: string) => void) {}

  start() {
    this.loop();
  }

  private async loop() {
    while (!this.closed && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.buf += this.decoder.decode(value, { stream: true });
          let i;
          while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i).replace(/\r$/, "");
            this.buf = this.buf.slice(i + 1);
            this.onLine(line);
          }
        }
      } catch {
        /* порт закрито або помилка читання */
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.closed) break;
      await sleep(100);
    }
  }

  private onLine(line: string) {
    const k = line.indexOf("DM:");
    if (k < 0) {
      if (line.trim()) this.onLog(line);
      return;
    }
    try {
      const msg = JSON.parse(line.slice(k + 3));
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.replies.push(msg);
    } catch {
      this.onLog(line);
    }
  }

  async send(obj: object) {
    const w = this.port.writable!.getWriter();
    try {
      await w.write(new TextEncoder().encode(JSON.stringify(obj) + "\n"));
    } finally {
      w.releaseLock();
    }
  }

  next(timeoutMs: number): Promise<any | null> {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    return new Promise((resolve) => {
      const fn = (v: any) => {
        clearTimeout(t);
        resolve(v);
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== fn);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(fn);
    });
  }

  /** Надсилає команду і чекає відповіді; повторює кожні `every` мс до `total` мс. */
  async request(obj: object, every: number, total: number): Promise<any | null> {
    const deadline = Date.now() + total;
    while (Date.now() < deadline) {
      await this.send(obj);
      const r = await this.next(Math.min(every, deadline - Date.now()));
      if (r) return r;
    }
    return null;
  }

  async close() {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* */
    }
    await sleep(50);
    await this.port.close().catch(() => {});
  }
}
