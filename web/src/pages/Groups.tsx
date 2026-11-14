import { useState } from "react";
import { Link } from "react-router-dom";
import { api, Firmware, Group } from "../api";
import { fmtValue, valueLevel } from "../format";
import { useFetch } from "../hooks";
import { useLive } from "../live";
import { toast, toastError } from "../toast";

export function GroupsPage() {
  const l = useLive();
  const groups = useFetch<{ groups: Group[]; ungrouped: Group }>("/groups", [l.version]);
  const firmware = useFetch<Firmware[]>("/firmware");
  const [edit, setEdit] = useState<{ id: number | null; name: string; interval: string; note: string } | null>(null);
  const [fwId, setFwId] = useState("");

  async function save() {
    if (!edit) return;
    const body = { name: edit.name, interval_s: edit.interval ? Number(edit.interval) : null, note: edit.note };
    try {
      if (edit.id === null) await api("/groups", { method: "POST", body });
      else await api(`/groups/${edit.id}`, { method: "PUT", body });
      setEdit(null);
      toast("Збережено");
      groups.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function del(g: Group) {
    if (!confirm(`Видалити групу «${g.name}»? Модулі залишаться, але без групи.`)) return;
    try {
      await api(`/groups/${g.id}`, { method: "DELETE" });
      groups.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function bulk(g: Group, name: string, params: any = {}) {
    try {
      const r = await api("/commands/bulk", { method: "POST", body: { group_id: g.id, name, params } });
      let msg = `«${g.name}»: надіслано ${r.queued}`;
      if (r.offline.length) msg += `, не на зв'язку ${r.offline.length}`;
      if (r.skipped.length) msg += `, пропущено ${r.skipped.length} (${r.skipped[0].reason})`;
      toast(msg, r.skipped.length > 0);
    } catch (e) {
      toastError(e);
    }
  }

  const lvlCls = (metric: string, v: number | null) => {
    const lv = valueLevel(metric, v);
    return "num " + (lv === "warn" || lv === "alarm" ? lv : "");
  };

  const list = groups.data?.groups ?? [];
  const ug = groups.data?.ungrouped;
  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => setEdit({ id: null, name: "", interval: "", note: "" })}>Нова група</button>
        <span className="sep" />
        <span className="info">Для дій над групою оберіть прошивку:</span>
        <select value={fwId} onChange={(e) => setFwId(e.target.value)}>
          <option value="">Прошивка…</option>
          {firmware.data?.filter((f) => f.kind === "app").map((f) => (
            <option key={f.id} value={f.id}>{f.chip} {f.version} ({f.filename})</option>
          ))}
        </select>
      </div>

      {edit && (
        <div className="panel" style={{ maxWidth: 560 }}>
          <div className="form-row"><label>Назва</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={{ flex: 1 }} autoFocus /></div>
          <div className="form-row">
            <label>Інтервал надсилання, с</label>
            <input type="number" min={1} max={3600} value={edit.interval} placeholder="типовий" onChange={(e) => setEdit({ ...edit, interval: e.target.value })} style={{ width: 90 }} />
            <span className="note">діє на модулі групи без власного інтервалу</span>
          </div>
          <div className="form-row"><label>Примітка</label><input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} style={{ flex: 1 }} /></div>
          <div className="toolbar">
            <button className="primary" disabled={!edit.name.trim()} onClick={save}>Зберегти</button>
            <button onClick={() => setEdit(null)}>Скасувати</button>
          </div>
        </div>
      )}

      <table className="grid">
        <thead>
          <tr>
            <th>Група</th><th className="num">Модулів</th><th className="num">На зв'язку</th><th className="num">Інтервал</th>
            <th className="num">Темп. чипа сер.</th><th className="num">Темп. чипа макс.</th><th className="num">Найслабший Wi-Fi</th>
            <th>Примітка</th><th>Дії</th>
          </tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <tr key={g.id}>
              <td>{g.name}</td>
              <td className="num">{g.total}</td>
              <td className={"num " + (g.total && g.online < g.total ? (g.online === 0 ? "alarm" : "warn") : "")}>{g.online}</td>
              <td className="num">{g.interval_s ? `${g.interval_s} с` : <span className="muted">типовий</span>}</td>
              <td className={lvlCls("chip_temp_c", g.temp_avg)}>{fmtValue("chip_temp_c", g.temp_avg)}</td>
              <td className={lvlCls("chip_temp_c", g.temp_max)}>{fmtValue("chip_temp_c", g.temp_max)}</td>
              <td className={lvlCls("rssi", g.rssi_min)}>{fmtValue("rssi", g.rssi_min)}</td>
              <td className="wrap">{g.note}</td>
              <td>
                <button className="small" onClick={() => setEdit({ id: g.id, name: g.name, interval: g.interval_s ? String(g.interval_s) : "", note: g.note })}>Змінити</button>{" "}
                <button className="small" disabled={!g.online} onClick={() => bulk(g, "led", { mode: "blink" })}>Блимати</button>{" "}
                <button className="small" disabled={!g.online} onClick={() => bulk(g, "led", { mode: "off" })}>LED вимк.</button>{" "}
                <button className="small" disabled={!g.online} onClick={() => confirm(`Перезапустити всі модулі групи «${g.name}»?`) && bulk(g, "restart")}>Перезапуск</button>{" "}
                <button className="small" disabled={!g.online || !fwId} onClick={() => confirm(`Оновити прошивку в групі «${g.name}»? Модулі з іншим чипом буде пропущено.`) && bulk(g, "ota", { firmware_id: Number(fwId) })}>Оновити прошивку</button>{" "}
                <button className="small danger" onClick={() => del(g)}>Видалити</button>
              </td>
            </tr>
          ))}
          {ug && (
            <tr>
              <td className="muted">Без групи</td>
              <td className="num">{ug.total}</td>
              <td className="num">{ug.online}</td>
              <td className="num muted">типовий</td>
              <td className={lvlCls("chip_temp_c", ug.temp_avg)}>{fmtValue("chip_temp_c", ug.temp_avg)}</td>
              <td className={lvlCls("chip_temp_c", ug.temp_max)}>{fmtValue("chip_temp_c", ug.temp_max)}</td>
              <td className={lvlCls("rssi", ug.rssi_min)}>{fmtValue("rssi", ug.rssi_min)}</td>
              <td /><td><Link to="/">До модулів</Link></td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
