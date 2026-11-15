// Обробка показників на модулі (docs/PROTOCOL.md 3.5): фільтри, межі норми, гібридний режим.
import { useEffect, useState } from "react";
import { api, Filter, Limit, Module } from "../api";
import { fmtValue, metricLabel, metricLevel } from "../format";
import { toast, toastError } from "../toast";

// Показники, для яких є сенс у фільтрі й межах (час роботи лише зростає)
const SKIP = new Set(["uptime_s"]);
const ORDER = ["chip_temp_c", "rssi", "heap_free", "heap_min_free"];

interface Row {
  ftype: "" | Filter["type"];
  window: string;
  alpha: string;
  min: string;
  max: string;
  hyst: string;
}

const s = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function rowsFrom(m: Module, metrics: string[]): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const k of metrics) {
    const f = m.filters?.[k];
    const l = m.limits?.[k];
    out[k] = {
      ftype: f?.type ?? "",
      window: s(f?.window ?? 5),
      alpha: s(f?.alpha ?? 0.2),
      min: s(l?.min),
      max: s(l?.max),
      hyst: l?.hyst ? String(l.hyst) : "",
    };
  }
  return out;
}

export function OnModule({ m, interval }: { m: Module; interval: number }) {
  const metrics = [...new Set([...ORDER, ...Object.keys(m.last_values ?? {})])]
    .filter((k) => !SKIP.has(k) && (k in (m.last_values ?? {}) || m.limits?.[k] || m.filters?.[k]))
    .sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  const key = JSON.stringify([m.id, m.hybrid, m.filters, m.limits, metrics]);
  const [rows, setRows] = useState<Record<string, Row>>(() => rowsFrom(m, metrics));
  const [hybrid, setHybrid] = useState(!!m.hybrid);
  const [normal, setNormal] = useState(s(m.hybrid?.normal_interval_s ?? 60));
  const [history, setHistory] = useState(s(m.hybrid?.history_s ?? 60));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(key);

  useEffect(() => {
    setRows(rowsFrom(m, metrics));
    setHybrid(!!m.hybrid);
    setNormal(s(m.hybrid?.normal_interval_s ?? 60));
    setHistory(s(m.hybrid?.history_s ?? 60));
    setSaved(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = (k: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } }));
  const dirtyKey = JSON.stringify([rows, hybrid, normal, history]);
  const [initial, setInitial] = useState(dirtyKey);
  useEffect(() => setInitial(dirtyKey), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = dirtyKey !== initial;

  async function save() {
    const filters: Record<string, Partial<Filter>> = {};
    const limits: Record<string, Partial<Limit>> = {};
    for (const [k, r] of Object.entries(rows)) {
      if (r.ftype) filters[k] = r.ftype === "ema" ? { type: "ema", alpha: Number(r.alpha) } : { type: r.ftype, window: Number(r.window) };
      if (r.min !== "" && r.max !== "" && Number(r.min) >= Number(r.max)) {
        toastError(new Error(`${metricLabel(k)}: нижня межа має бути менша за верхню`));
        return;
      }
      if (r.min !== "" || r.max !== "") {
        limits[k] = { min: r.min === "" ? null : Number(r.min), max: r.max === "" ? null : Number(r.max), hyst: r.hyst === "" ? 0 : Number(r.hyst) };
      }
    }
    setBusy(true);
    try {
      await api(`/modules/${m.id}`, {
        method: "PATCH",
        body: {
          filters,
          limits,
          hybrid: hybrid ? { normal_interval_s: Number(normal), history_s: Number(history) } : null,
        },
      });
      toast("Збережено, модуль отримає налаштування");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const supported = m.caps?.includes("limits");
  return (
    <>
      <h2>Обробка на модулі</h2>
      {!supported && (
        <div className="panel warn-panel">
          <span className="badge warn">Увага</span> Прошивка модуля {m.fw ?? ""} цього не вміє. Налаштування збережуться, але
          діятимуть після оновлення прошивки до 0.3.0 або новішої.
        </div>
      )}
      <div className="panel">
        <div className="form-row">
          <label>
            <input type="checkbox" checked={hybrid} onChange={(e) => setHybrid(e.target.checked)} /> Гібридний режим
          </label>
          <span className="note">поки все в нормі, надсилати рідко; при виході за межі одразу і часто</span>
        </div>
        {hybrid && (
          <>
            <div className="form-row">
              <label>У нормі раз на, с</label>
              <input type="number" min={1} max={3600} value={normal} onChange={(e) => setNormal(e.target.value)} style={{ width: 90 }} />
              <span className="note">під час тривоги: звичайний інтервал ({interval} с)</span>
            </div>
            <div className="form-row">
              <label>Передісторія, с</label>
              <input type="number" min={0} max={60} value={history} onChange={(e) => setHistory(e.target.value)} style={{ width: 90 }} />
              <span className="note">виміри перед тривогою, що надсилаються разом із нею (до 60)</span>
            </div>
          </>
        )}
        {hybrid && !Object.values(rows).some((r) => r.min !== "" || r.max !== "") && (
          <div className="note warn-text">Задайте межі норми хоча б для одного показника, інакше модуль завжди вважатиме, що все в нормі.</div>
        )}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Показник</th>
            <th>Фільтр</th>
            <th>Вікно / α</th>
            <th className="num">Нижня межа</th>
            <th className="num">Верхня межа</th>
            <th className="num">Гістерезис</th>
            <th className="num">Зараз</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((k) => {
            const r = rows[k];
            if (!r) return null;
            const lvl = metricLevel(m, k);
            return (
              <tr key={k}>
                <td>{metricLabel(k)}</td>
                <td>
                  <select value={r.ftype} onChange={(e) => set(k, { ftype: e.target.value as Row["ftype"] })}>
                    <option value="">без фільтра</option>
                    <option value="avg">ковзне середнє</option>
                    <option value="median">медіана</option>
                    <option value="ema">експоненційне</option>
                  </select>
                </td>
                <td>
                  {(r.ftype === "avg" || r.ftype === "median") && (
                    <input type="number" min={2} max={30} value={r.window} onChange={(e) => set(k, { window: e.target.value })} title="Скільки останніх вимірів (2–30)" />
                  )}
                  {r.ftype === "ema" && (
                    <input type="number" min={0.01} max={1} step={0.05} value={r.alpha} onChange={(e) => set(k, { alpha: e.target.value })} title="Вага нового виміру (0,01–1): менше = плавніше" />
                  )}
                </td>
                <td className="num"><input type="number" value={r.min} onChange={(e) => set(k, { min: e.target.value })} placeholder="—" /></td>
                <td className="num"><input type="number" value={r.max} onChange={(e) => set(k, { max: e.target.value })} placeholder="—" /></td>
                <td className="num">
                  <input type="number" min={0} value={r.hyst} onChange={(e) => set(k, { hyst: e.target.value })} placeholder="0" disabled={r.min === "" && r.max === ""}
                    title="Запас повернення в норму, щоб тривога не вмикалася й не вимикалася на самій межі" />
                </td>
                <td className={"num " + (lvl === "warn" || lvl === "alarm" ? lvl : "")}>{fmtValue(k, m.last_values?.[k])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button className="primary" disabled={!dirty || busy} onClick={save}>Зберегти обробку</button>
        <span className="note">Фільтр згладжує виміри до надсилання (на сервер ідуть уже відфільтровані значення). Порожні межі: без контролю.</span>
      </div>
    </>
  );
}
