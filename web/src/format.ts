import { Module } from "./api";

export const METRIC_LABELS: Record<string, { label: string; unit: string; digits: number }> = {
  rssi: { label: "Рівень Wi-Fi", unit: "дБм", digits: 0 },
  chip_temp_c: { label: "Температура чипа", unit: "°C", digits: 1 },
  uptime_s: { label: "Час роботи", unit: "с", digits: 0 },
  heap_free: { label: "Вільна пам'ять", unit: "байт", digits: 0 },
  heap_min_free: { label: "Мінімум вільної пам'яті", unit: "байт", digits: 0 },
};

export function metricLabel(m: string) {
  return METRIC_LABELS[m]?.label ?? m;
}

export function fmtValue(metric: string, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (metric === "uptime_s") return fmtDuration(v);
  if (metric === "heap_free" || metric === "heap_min_free") return `${(v / 1024).toFixed(0)} КБ`;
  const info = METRIC_LABELS[metric];
  const d = info ? info.digits : Math.abs(v) < 10 ? 2 : 1;
  return `${v.toFixed(d)}${info ? " " + info.unit : ""}`;
}

export function fmtDuration(s: number): string {
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} д ${h} год`;
  if (h) return `${h} год ${m} хв`;
  if (m) return `${m} хв ${s % 60} с`;
  return `${s} с`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("uk-UA");
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "ніколи";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "щойно";
  if (s < 60) return `${s} с тому`;
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  if (s < 86400) return `${Math.floor(s / 3600)} год тому`;
  return `${Math.floor(s / 86400)} д тому`;
}

export function fmtBytes(n: number) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} МБ`;
  return `${(n / 1024).toFixed(0)} КБ`;
}

export function moduleTitle(m: Module) {
  return m.name || m.id;
}

export type Level = "ok" | "warn" | "alarm" | "none";

// Стан зв'язку: online за статусом, але без даних довше 3 інтервалів + 10 с — «немає даних».
export function linkState(m: Module, now = Date.now()): { level: Level; text: string } {
  if (!m.online) return { level: "alarm", text: "Немає зв'язку" };
  // у гібридному режимі модуль у нормі надсилає рідше
  const interval = Math.max(m.interval_s ?? m.effective_interval_s ?? 1, m.hybrid?.normal_interval_s ?? 0);
  if (m.last_seen_at) {
    const age = (now - new Date(m.last_seen_at).getTime()) / 1000;
    if (age > interval * 3 + 10) return { level: "warn", text: "Немає даних" };
  }
  return { level: "ok", text: "На зв'язку" };
}

// Підсвічування показника: якщо для нього задано межі норми на модулі, стан повідомляє сам модуль;
// інакше типові пороги для показників самої плати.
export function metricLevel(m: Module, metric: string): Level {
  if (!m.online) return "none";
  if (m.limits?.[metric]) return m.alarms?.includes(metric) ? "alarm" : "ok";
  return valueLevel(metric, m.last_values?.[metric]);
}

// Пороги підсвічування для показників самої плати (етап 1).
export function valueLevel(metric: string, v: number | undefined | null): Level {
  if (v === undefined || v === null) return "none";
  if (metric === "rssi") return v < -90 ? "alarm" : v < -80 ? "warn" : "ok";
  if (metric === "chip_temp_c") return v > 85 ? "alarm" : v > 70 ? "warn" : "ok";
  if (metric === "heap_free" || metric === "heap_min_free") return v < 20000 ? "alarm" : v < 50000 ? "warn" : "ok";
  return "none";
}

export const CMD_LABELS: Record<string, string> = {
  led: "Світлодіод",
  restart: "Перезапуск",
  ota: "Оновлення прошивки",
};

export const CMD_STATUS: Record<string, { text: string; level: Level }> = {
  queued: { text: "У черзі", level: "none" },
  sent: { text: "Надіслано", level: "none" },
  in_progress: { text: "Виконується", level: "warn" },
  ok: { text: "Виконано", level: "ok" },
  error: { text: "Помилка", level: "alarm" },
  timeout: { text: "Немає відповіді", level: "alarm" },
};

export function cmdParams(c: { name: string; params: any }) {
  if (c.name === "led") return { on: "увімк.", off: "вимк.", blink: "блимати", breathe: "дихання", rainbow: "веселка" }[c.params?.mode as string] ?? "";
  if (c.name === "ota") return c.params?.version ? `версія ${c.params.version}` : "";
  return "";
}
