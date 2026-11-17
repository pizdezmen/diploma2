import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import uPlot from "uplot";
import { api, Command, EventRow, Firmware, Group, Module } from "../api";
import { Chart, SeriesData, withGaps } from "../Chart";
import {
  CMD_LABELS, CMD_STATUS, cmdParams, fmtAgo, fmtTime, fmtValue, linkState, metricLabel, metricLevel, moduleTitle,
} from "../format";
import { useFetch, useNow } from "../hooks";
import { live, useLive } from "../live";
import { toast, toastError } from "../toast";
import { Addons } from "./Addons";
import { OnModule } from "./OnModule";

const RANGES = [
  { key: "live", label: "Наживо 5 хв", s: 300 },
  { key: "1h", label: "1 год", s: 3600 },
  { key: "24h", label: "24 год", s: 86400 },
  { key: "7d", label: "7 днів", s: 7 * 86400 },
  { key: "30d", label: "30 днів", s: 30 * 86400 },
  { key: "1y", label: "Рік", s: 365 * 86400 },
];
const METRIC_ORDER = ["rssi", "chip_temp_c", "heap_free", "uptime_s"];

export function ModulePage() {
  const { id = "" } = useParams();
  const l = useLive();
  const now = useNow();
  const nav = useNavigate();
  const detail = useFetch<Module>(`/modules/${id}`);
  const groups = useFetch<{ groups: Group[] }>("/groups");
  const firmware = useFetch<Firmware[]>("/firmware");
  const commands = useFetch<Command[]>(`/modules/${id}/commands?limit=30`);
  const events = useFetch<EventRow[]>(`/modules/${id}/events?limit=50`);
  const m = l.modules.get(id);

  useEffect(
    () =>
      live.onCommand((c) => {
        if (c.module_id !== id) return;
        commands.setData((list) => {
          const rest = (list ?? []).filter((x) => x.id !== c.id);
          return [c, ...rest].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30);
        });
        if (c.status === "error" || c.status === "timeout") toast(`${CMD_LABELS[c.name] ?? c.name}: ${c.message || CMD_STATUS[c.status].text}`, true);
      }),
    [id],
  );

  // події оновлюємо при зміні стану модуля
  useEffect(() => {
    events.reload();
  }, [m?.online, m?.fw, m?.provisioned, m?.alarms?.join()]);

  if (!m) {
    return <div className="note">{l.modules.size ? "Модуль не знайдено" : "Завантаження…"}</div>;
  }
  const st = linkState({ ...m, effective_interval_s: detail.data?.effective_interval_s }, now);
  const fwList = (firmware.data ?? []).filter((f) => f.kind === "app" && (!m.chip || f.chip === m.chip));

  async function cmd(name: string, params: any = {}) {
    try {
      await api(`/modules/${id}/commands`, { method: "POST", body: { name, params } });
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <h1>
        {moduleTitle(m)} <span className="mono muted">{m.id}</span>{" "}
        <span className={"dot " + st.level} />
        <span className="note">{st.text}</span>
      </h1>
      <div className="toolbar">
        <button disabled={!m.online} onClick={() => confirm("Перезапустити модуль?") && cmd("restart")}>Перезапустити</button>
        <span className="sep" />
        <OtaControl list={fwList} disabled={!m.online} current={m.fw} onRun={(fid) => cmd("ota", { firmware_id: fid })} />
      </div>

      <div className="layout-2">
        <div>
          <Properties m={m} detail={detail.data} groups={groups.data?.groups ?? []} onSaved={() => detail.reload()} />
          <Maintenance m={m} onDeleted={() => nav("/")} />
        </div>
        <div>
          <Charts id={id} metrics={detail.data?.metrics ?? Object.keys(m.last_values ?? {})}
            interval={Math.max(detail.data?.effective_interval_s ?? 1, m.hybrid?.normal_interval_s ?? 0)} limits={m.limits ?? {}} />
        </div>
      </div>

      <OnModule m={m} interval={detail.data?.effective_interval_s ?? 1} />

      <Addons m={m} metrics={detail.data?.metrics ?? []} onCommand={cmd} />

      <h2>Команди</h2>
      <table className="grid">
        <thead>
          <tr><th>Час</th><th>Команда</th><th>Параметри</th><th>Стан</th><th>Повідомлення</th></tr>
        </thead>
        <tbody>
          {(commands.data ?? []).map((c) => {
            const s = CMD_STATUS[c.status] ?? { text: c.status, level: "none" };
            return (
              <tr key={c.id}>
                <td>{fmtTime(c.created_at)}</td>
                <td>{CMD_LABELS[c.name] ?? c.name}</td>
                <td>{cmdParams(c)}</td>
                <td className={s.level === "warn" || s.level === "alarm" ? s.level : s.level === "ok" ? "ok" : ""}>
                  {c.status === "in_progress" && c.progress != null && (
                    <span className="progress"><div style={{ width: `${c.progress}%` }} /></span>
                  )}
                  {s.text}
                </td>
                <td className="wrap">{c.message}</td>
              </tr>
            );
          })}
          {commands.data?.length === 0 && <tr><td colSpan={5} className="muted">Команд ще не було</td></tr>}
        </tbody>
      </table>

      <h2>Події</h2>
      <table className="grid">
        <thead><tr><th>Час</th><th>Подія</th></tr></thead>
        <tbody>
          {(events.data ?? []).map((e) => (
            <tr key={e.id}>
              <td>{fmtTime(e.time)}</td>
              <td className={e.level === "warning" ? "warn" : e.level === "alarm" ? "alarm" : ""}>{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function OtaControl({ list, disabled, current, onRun }: { list: Firmware[]; disabled: boolean; current: string | null; onRun: (id: number) => void }) {
  const [fid, setFid] = useState("");
  return (
    <>
      <select value={fid} onChange={(e) => setFid(e.target.value)}>
        <option value="">Прошивка…</option>
        {list.map((f) => (
          <option key={f.id} value={f.id}>
            {f.version} {f.version === current ? "(поточна)" : ""} — {f.filename}
          </option>
        ))}
      </select>
      <button disabled={disabled || !fid} onClick={() => confirm("Оновити прошивку модуля?") && onRun(Number(fid))}>Оновити прошивку</button>
    </>
  );
}

// Межа потужності передавача Wi-Fi, дБм (драйвер приймає 2–21 з кроком 0,25)
const WIFI_TX_STEPS = [19.5, 17, 15, 13, 11, 8.5, 5, 2];

function Properties({ m, detail, groups, onSaved }: { m: Module; detail: Module | null; groups: Group[]; onSaved: () => void }) {
  const [name, setName] = useState(m.name);
  const [note, setNote] = useState(m.note);
  const [group, setGroup] = useState(m.group_id === null ? "" : String(m.group_id));
  const [interval, setIntervalS] = useState(m.interval_s === null ? "" : String(m.interval_s));
  const [tx, setTx] = useState(m.wifi_tx_dbm === null ? "" : String(m.wifi_tx_dbm));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTx(m.wifi_tx_dbm === null ? "" : String(m.wifi_tx_dbm));
    setName(m.name);
    setNote(m.note);
    setGroup(m.group_id === null ? "" : String(m.group_id));
    setIntervalS(m.interval_s === null ? "" : String(m.interval_s));
  }, [m.id, m.name, m.note, m.group_id, m.interval_s, m.wifi_tx_dbm]);

  const dirty =
    name !== m.name || note !== m.note || group !== (m.group_id === null ? "" : String(m.group_id)) ||
    interval !== (m.interval_s === null ? "" : String(m.interval_s)) ||
    tx !== (m.wifi_tx_dbm === null ? "" : String(m.wifi_tx_dbm));
  const txSupported = m.caps?.includes("wifi_tx");
  const txOptions = [...new Set([...WIFI_TX_STEPS, ...(m.wifi_tx_dbm === null ? [] : [m.wifi_tx_dbm])])].sort((a, b) => b - a);
  const grp = groups.find((g) => String(g.id) === group);

  async function save() {
    setBusy(true);
    try {
      await api(`/modules/${m.id}`, {
        method: "PATCH",
        body: { name, note, group_id: group ? Number(group) : null, interval_s: interval ? Number(interval) : null,
          wifi_tx_dbm: tx ? Number(tx) : null },
      });
      toast("Збережено");
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const lv = m.last_values ?? {};
  const configOk = m.applied_config_rev === m.config_rev;
  return (
    <>
      <h2>Налаштування</h2>
      <div className="panel">
        <div className="form-row"><label>Назва</label><input value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} /></div>
        <div className="form-row">
          <label>Група</label>
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ flex: 1 }}>
            <option value="">Без групи</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>Інтервал надсилання, с</label>
          <input type="number" min={1} max={3600} value={interval} onChange={(e) => setIntervalS(e.target.value)} style={{ width: 90 }}
            placeholder={grp?.interval_s ? String(grp.interval_s) : "типовий"} />
          <span className="note">{interval ? "свій" : grp?.interval_s ? `як у групи (${grp.interval_s} с)` : "типовий"}</span>
        </div>
        <div className="form-row">
          <label>Потужність Wi-Fi</label>
          <select value={tx} onChange={(e) => setTx(e.target.value)} disabled={!txSupported && !tx}>
            <option value="">Найбільша (типово)</option>
            {txOptions.map((v) => <option key={v} value={String(v)}>{v} дБм</option>)}
          </select>
          <span className="note">
            {!txSupported ? "потрібна прошивка 0.5.2 або новіша"
              : m.wifi_tx_now !== null ? `зараз ${m.wifi_tx_now} дБм` : ""}
            {txSupported && " · менше потужність — менший піковий струм; рівень сигналу трохи впаде"}
          </span>
        </div>
        <div className="form-row"><label>Примітка</label><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ flex: 1 }} /></div>
        <button className="primary" disabled={!dirty || busy} onClick={save}>Зберегти</button>
      </div>

      <h2>Відомості</h2>
      <table className="grid kv">
        <tbody>
          <tr><th>Чип</th><td>{m.chip ?? "—"}</td></tr>
          <tr><th>Прошивка</th><td>{m.fw ?? "—"} <span className="muted">ESP-IDF {m.idf ?? "?"}</span></td></tr>
          <tr><th>IP / мережа</th><td>{m.ip ?? "—"} <span className="muted">{m.ssid ?? ""}</span></td></tr>
          <tr><th>Причина останнього старту</th><td>{m.reset_reason ?? "—"}</td></tr>
          <tr><th>Підтримує команди</th><td>{m.caps?.join(", ") || "—"}</td></tr>
          <tr><th>Діючий інтервал</th><td>{detail?.effective_interval_s ?? "?"} с</td></tr>
          <tr><th>Конфігурація</th><td className={configOk ? "" : "warn"}>{configOk ? `застосована (ревізія ${m.config_rev})` : `очікує застосування (${m.applied_config_rev} → ${m.config_rev})`}</td></tr>
          {["rssi", "chip_temp_c", "uptime_s", "heap_free", ...Object.keys(lv).filter((k) => !METRIC_ORDER.includes(k)).sort()]
            .filter((k) => k in lv)
            .map((k) => {
              const lvl = metricLevel(m, k);
              return (
                <tr key={k}><th>{metricLabel(k)}</th><td className={lvl === "warn" || lvl === "alarm" ? lvl : m.online ? "" : "muted"}>{fmtValue(k, lv[k])}</td></tr>
              );
            })}
          <tr><th>Останні дані</th><td>{fmtTime(m.last_seen_at)}</td></tr>
          <tr><th>Додано</th><td>{fmtTime(m.created_at)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function Maintenance({ m, onDeleted }: { m: Module; onDeleted: () => void }) {
  async function reset() {
    if (!confirm("Скинути пароль MQTT? Модуль відключиться і зареєструється знову з новим паролем.")) return;
    try {
      await api(`/modules/${m.id}/reset-credentials`, { method: "POST" });
      toast("Пароль скинуто");
    } catch (e) {
      toastError(e);
    }
  }
  async function del() {
    if (!confirm("Видалити модуль і всю його історію? Щоб він знову з'явився, достатньо його перезапустити.")) return;
    try {
      await api(`/modules/${m.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <>
      <h2>Обслуговування</h2>
      {m.provision_denied_at && m.provisioned && (
        <div className="panel warn-panel">
          <span className="badge warn">Увага</span> {fmtAgo(m.provision_denied_at)} модуль просив новий пароль MQTT (наприклад, після
          стирання пам'яті). Якщо це ваш модуль, скиньте пароль.
        </div>
      )}
      <div className="toolbar">
        <button onClick={reset}>Скинути пароль MQTT</button>
        <button className="danger" onClick={del}>Видалити модуль</button>
        {!m.provisioned && <span className="badge warn">Чекає повторної реєстрації</span>}
      </div>
    </>
  );
}

function Charts({ id, metrics, interval, limits }: { id: string; metrics: string[]; interval: number; limits: Module["limits"] }) {
  const [range, setRange] = useState("live");
  const [series, setSeries] = useState<Record<string, SeriesData>>({});
  const [source, setSource] = useState("raw");
  const [step, setStep] = useState(1);
  const [tick, setTick] = useState(0);
  const buf = useRef<Record<string, SeriesData>>({});
  const r = RANGES.find((x) => x.key === range)!;

  const load = async () => {
    const to = new Date();
    const from = new Date(to.getTime() - r.s * 1000);
    try {
      const res = await api<{ source: string; step_s: number; series: Record<string, SeriesData> }>(
        `/modules/${id}/telemetry?from=${from.toISOString()}&to=${to.toISOString()}`,
      );
      buf.current = res.series;
      setSource(res.source);
      setStep(res.step_s);
      setSeries({ ...res.series });
    } catch (e) {
      toastError(e);
    }
  };

  useEffect(() => {
    load();
    if (range !== "live") {
      const t = setInterval(load, r.s <= 3600 ? 10000 : 60000);
      return () => clearInterval(t);
    }
    // наживо: дописуємо точки з WebSocket, перемальовуємо раз на секунду
    const off = live.onTelemetry(id, (ts, values) => {
      for (const [k, v] of Object.entries(values)) {
        const s = (buf.current[k] ??= { t: [], v: [] });
        s.t.push(ts);
        s.v.push(v);
      }
    });
    const t = setInterval(() => {
      const cutoff = Date.now() - r.s * 1000 - 5000;
      for (const s of Object.values(buf.current)) {
        let i = 0;
        while (i < s.t.length && s.t[i] < cutoff) i++;
        if (i) {
          s.t.splice(0, i);
          s.v.splice(0, i);
        }
      }
      setSeries({ ...buf.current });
      setTick((x) => x + 1);
    }, 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [id, range]);

  const names = useMemo(() => {
    const all = new Set([...metrics, ...Object.keys(series)]);
    return [...all].sort((a, b) => {
      const ia = METRIC_ORDER.indexOf(a), ib = METRIC_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  }, [metrics, series]);

  const nowS = Date.now() / 1000;
  const xRange: [number, number] = [nowS - r.s, nowS];
  const gap = source === "raw" ? Math.max(interval, step) * 3 + 2 : step * 2.5;
  void tick;

  return (
    <>
      <h2>Графіки</h2>
      <div className="toolbar">
        <span className="seg">
          {RANGES.map((x) => (
            <button key={x.key} className={x.key === range ? "on" : ""} onClick={() => setRange(x.key)}>{x.label}</button>
          ))}
        </span>
        <span className="info">
          {source === "raw" ? "сирі дані" : source === "1m" ? "середні за хвилину (смуга: мін–макс)" : "середні за годину (смуга: мін–макс)"}
        </span>
      </div>
      {names.length === 0 && <div className="note">Даних ще немає</div>}
      {names.map((k) => {
        const s = series[k] ?? { t: [], v: [] };
        const data: uPlot.AlignedData = withGaps(s, gap);
        return (
          <div key={k} className="panel">
            <div className="chart-title">{metricLabel(k)}</div>
            <Chart metric={k} data={data} xRange={xRange} limits={limits[k]} />
          </div>
        );
      })}
    </>
  );
}
