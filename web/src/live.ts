// Живий стан: список модулів (оновлюється через WebSocket) і потік телеметрії для відкритих графіків.
import { useSyncExternalStore } from "react";
import { api, Command, Module } from "./api";
import { Alert } from "./rulesApi";
import { toast } from "./toast";

type TelemetryListener = (ts: number, values: Record<string, number>) => void;
type CommandListener = (c: Command) => void;

class LiveStore {
  modules = new Map<string, Module>();
  alerts = new Map<number, Alert>(); // активні тривоги
  version = 0;
  connected = false;
  private listeners = new Set<() => void>();
  private telemetry = new Map<string, Set<TelemetryListener>>();
  private commandListeners = new Set<CommandListener>();
  private ws: WebSocket | null = null;
  private stopped = true;
  private retry = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  async start() {
    this.stopped = false;
    await this.reload();
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  async reload() {
    const [list, alerts] = await Promise.all([api<Module[]>("/modules"), api<Alert[]>("/alerts?active=true")]);
    this.modules = new Map(list.map((m) => [m.id, m]));
    this.alerts = new Map(alerts.map((a) => [a.id, a]));
    this.emit();
  }

  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.sendSubscriptions();
      this.reload().catch(() => {});
    };
    ws.onclose = () => {
      this.connected = false;
      this.emit();
      if (!this.stopped) {
        this.retry = Math.min(this.retry + 1, 5);
        setTimeout(() => this.connect(), 1000 * this.retry);
      }
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
  }

  private onMessage(msg: any) {
    switch (msg.type) {
      case "telemetry":
        this.telemetry.get(msg.module)?.forEach((fn) => fn(msg.ts, msg.values));
        break;
      case "latest":
        for (const [id, v] of Object.entries<any>(msg.data)) {
          const m = this.modules.get(id);
          if (m) this.modules.set(id, { ...m, ...v });
        }
        this.emit();
        break;
      case "module":
        if (msg.data) {
          const old = this.modules.get(msg.data.id);
          this.modules.set(msg.data.id, { ...old, ...msg.data });
          this.emit();
        }
        break;
      case "module_added":
        if (msg.data) {
          this.modules.set(msg.data.id, msg.data);
          this.emit();
        } else this.reload().catch(() => {});
        break;
      case "module_removed":
        this.modules.delete(msg.id);
        this.emit();
        break;
      case "alert": {
        const a: Alert = msg.data;
        const isNew = !this.alerts.has(a.id);
        if (a.ended_at) this.alerts.delete(a.id);
        else this.alerts.set(a.id, a);
        if (isNew && !a.ended_at) toast(a.message, a.level === "alarm");
        this.emit();
        break;
      }
      case "command":
        this.commandListeners.forEach((fn) => fn(msg.data));
        break;
    }
  }

  private sendSubscriptions() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ subscribe: [...this.telemetry.keys()] }));
    }
  }

  onTelemetry(id: string, fn: TelemetryListener) {
    let set = this.telemetry.get(id);
    if (!set) {
      set = new Set();
      this.telemetry.set(id, set);
      this.sendSubscriptions();
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) {
        this.telemetry.delete(id);
        this.sendSubscriptions();
      }
    };
  }

  onCommand(fn: CommandListener) {
    this.commandListeners.add(fn);
    return () => {
      this.commandListeners.delete(fn);
    };
  }
}

export const live = new LiveStore();

export function useLive() {
  useSyncExternalStore(live.subscribe, live.getVersion);
  return live;
}
