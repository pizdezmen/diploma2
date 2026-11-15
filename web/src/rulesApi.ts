// Типи етапу 3: правила автоматизації, тривоги, канали сповіщень.
export type RuleLevel = "info" | "warning" | "alarm";

export type Scope = { type: "all" } | { type: "group"; group_id: number } | { type: "modules"; ids: string[] };

export type Trigger =
  | { type: "metric"; metric: string; op: string; value: number; for_s: number }
  | { type: "offline"; for_s: number }
  | { type: "online" }
  | { type: "schedule"; mode: "daily"; time: string; days: number[] }
  | { type: "schedule"; mode: "every"; every_min: number };

export type Action =
  | { type: "command"; name: "led"; params: { mode: "on" | "off" | "blink" }; target: string | null }
  | { type: "command"; name: "restart"; params: {}; target: string | null }
  | { type: "interval"; interval_s: number | null; target: string | null }
  | { type: "screen"; slot: number; text: string; duration_s: number; target: string | null };

export interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  scope: Scope;
  trigger: Trigger;
  actions: Action[];
  recovery_actions: Action[];
  level: RuleLevel;
  notify: boolean;
  message: string;
  cooldown_s: number;
  note: string;
  last_fired_at: string | null;
  created_at: string;
  summary: string;
  active: number;
}

export interface Alert {
  id: number;
  rule_id: number | null;
  rule_name: string | null;
  source: string;
  key: string;
  module_id: string | null;
  level: RuleLevel;
  message: string;
  value: number | null;
  started_at: string;
  ended_at: string | null;
  acknowledged_at: string | null;
}

export interface ChannelType {
  type: string;
  title: string;
  fields: { key: string; label: string; secret: boolean }[];
}

export interface Channel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  min_level: RuleLevel;
  config: Record<string, any>;
  last_error: string;
  created_at: string;
}

export interface RulesMeta {
  metrics: Record<string, { label: string; unit: string }>;
  levels: RuleLevel[];
  timezone: string;
  channel_types: ChannelType[];
}

export const LEVEL_TEXT: Record<RuleLevel, string> = { info: "Інформація", warning: "Попередження", alarm: "Тривога" };
// Клас комірки таблиці для рівня (warn/alarm підсвічуються кольором)
export const LEVEL_CLS: Record<RuleLevel, string> = { info: "", warning: "warn", alarm: "alarm" };

export const OPS = [">", ">=", "<", "<=", "=", "!="];
export const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

export function actionText(a: Action, title: (id: string) => string): string {
  let s: string;
  if (a.type === "interval") s = a.interval_s ? `Інтервал ${a.interval_s} с` : "Інтервал як у групи";
  else if (a.type === "screen") s = a.text ? `На екран (місце ${a.slot}): «${a.text}»` : `Прибрати з екрана (місце ${a.slot})`;
  else if (a.name === "restart") s = "Перезапуск";
  else s = "Світлодіод: " + ({ on: "увімк.", off: "вимк.", blink: "блимати" }[a.params.mode] ?? "");
  if (a.target) s += ` (${title(a.target)})`;
  return s;
}
