export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method || "GET", credentials: "same-origin" };
  if (opts.form) {
    init.body = opts.form;
  } else if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch("/api" + path, init);
  if (res.status === 401 && path !== "/auth/login") {
    onUnauthorized();
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* немає тіла */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

export interface Module {
  id: string;
  name: string;
  note: string;
  group_id: number | null;
  chip: string | null;
  fw: string | null;
  idf: string | null;
  ip: string | null;
  ssid: string | null;
  reset_reason: string | null;
  led: string | null;
  caps: string[];
  online: boolean;
  interval_s: number | null;
  config_rev: number;
  applied_config_rev: number;
  provisioned: boolean;
  provision_denied_at: string | null;
  last_values: Record<string, number>;
  last_seen_at: string | null;
  last_status_at: string | null;
  created_at: string;
  effective_interval_s?: number;
  metrics?: string[];
}

export interface Group {
  id: number;
  name: string;
  interval_s: number | null;
  note: string;
  total: number;
  online: number;
  temp_avg: number | null;
  temp_max: number | null;
  rssi_min: number | null;
}

export interface Command {
  id: string;
  module_id: string;
  name: string;
  params: any;
  status: string;
  progress: number | null;
  message: string;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Firmware {
  id: number;
  filename: string;
  chip: string;
  version: string;
  project: string;
  idf: string;
  build_time: string;
  size: number;
  sha256: string;
  note: string;
  uploaded_at: string;
}

export interface EventRow {
  id: number;
  time: string;
  module_id: string | null;
  level: string;
  message: string;
}
