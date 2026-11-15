import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtDuration, fmtTime, moduleTitle } from "../format";
import { useFetch, useNow } from "../hooks";
import { useLive } from "../live";
import { Alert, Channel, LEVEL_CLS, LEVEL_TEXT, RuleLevel, RulesMeta } from "../rulesApi";
import { toast, toastError } from "../toast";

export function AlertsPage() {
  const l = useLive();
  const now = useNow();
  const history = useFetch<Alert[]>("/alerts?limit=300", [l.alerts.size]);
  const active = [...l.alerts.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));

  const mod = (id: string | null) => {
    if (!id) return "—";
    const m = l.modules.get(id);
    return <Link to={`/modules/${id}`}>{m ? moduleTitle(m) : id}</Link>;
  };
  const rowCls = (a: Alert) => (a.acknowledged_at ? "ack " : "") + LEVEL_CLS[a.level];

  async function ack(a: Alert) {
    try {
      await api(`/alerts/${a.id}/ack`, { method: "POST" });
    } catch (e) {
      toastError(e);
    }
  }

  async function ackAll() {
    try {
      await api("/alerts/ack-all", { method: "POST" });
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <h2>Активні тривоги</h2>
      <div className="toolbar">
        <button disabled={!active.some((a) => !a.acknowledged_at)} onClick={ackAll}>Підтвердити всі</button>
        <span className="info">Тривога зникає сама, коли показник повертається в норму. «Підтвердити» означає «бачу», лічильник у меню її більше не рахує.</span>
      </div>
      <table className="grid">
        <thead>
          <tr><th>Початок</th><th className="num">Триває</th><th>Модуль</th><th>Рівень</th><th>Повідомлення</th><th>Правило</th><th /></tr>
        </thead>
        <tbody>
          {active.map((a) => (
            <tr key={a.id} className={rowCls(a)}>
              <td>{fmtTime(a.started_at)}</td>
              <td className="num">{fmtDuration((now - new Date(a.started_at).getTime()) / 1000)}</td>
              <td>{mod(a.module_id)}</td>
              <td>{LEVEL_TEXT[a.level]}</td>
              <td className="wrap">{a.message}</td>
              <td>{a.rule_name ?? (a.source === "rule" ? "—" : "від модуля")}</td>
              <td>{a.acknowledged_at ? <span className="muted">підтверджено</span> : <button className="small" onClick={() => ack(a)}>Підтвердити</button>}</td>
            </tr>
          ))}
          {active.length === 0 && <tr><td colSpan={7} className="muted">Активних тривог немає</td></tr>}
        </tbody>
      </table>

      <h2>Історія тривог</h2>
      <table className="grid">
        <thead>
          <tr><th>Початок</th><th>Кінець</th><th className="num">Тривала</th><th>Модуль</th><th>Рівень</th><th>Повідомлення</th></tr>
        </thead>
        <tbody>
          {(history.data ?? []).filter((a) => a.ended_at).map((a) => (
            <tr key={a.id}>
              <td>{fmtTime(a.started_at)}</td>
              <td>{fmtTime(a.ended_at)}</td>
              <td className="num">{fmtDuration((new Date(a.ended_at!).getTime() - new Date(a.started_at).getTime()) / 1000)}</td>
              <td>{mod(a.module_id)}</td>
              <td className={LEVEL_CLS[a.level]}>{LEVEL_TEXT[a.level]}</td>
              <td className="wrap">{a.message}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Channels />
    </>
  );
}

interface ChForm {
  id: number | null;
  name: string;
  type: string;
  enabled: boolean;
  min_level: RuleLevel;
  config: Record<string, any>;
}

function Channels() {
  const meta = useFetch<RulesMeta>("/rules/meta");
  const list = useFetch<Channel[]>("/channels");
  const [f, setF] = useState<ChForm | null>(null);
  const types = meta.data?.channel_types ?? [];
  const typeOf = (t: string) => types.find((x) => x.type === t);

  async function save() {
    if (!f) return;
    try {
      const body = { name: f.name, type: f.type, enabled: f.enabled, min_level: f.min_level, config: f.config };
      if (f.id === null) await api("/channels", { method: "POST", body });
      else await api(`/channels/${f.id}`, { method: "PUT", body });
      setF(null);
      toast("Збережено");
      list.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function test(c: Channel) {
    try {
      await api(`/channels/${c.id}/test`, { method: "POST" });
      toast(`«${c.name}»: надіслано`);
    } catch (e) {
      toastError(e);
    }
    list.reload();
  }

  async function del(c: Channel) {
    if (!confirm(`Видалити канал «${c.name}»?`)) return;
    try {
      await api(`/channels/${c.id}`, { method: "DELETE" });
      list.reload();
    } catch (e) {
      toastError(e);
    }
  }

  const ft = f ? typeOf(f.type) : undefined;
  return (
    <>
      <h2>Канали сповіщень</h2>
      <div className="toolbar">
        <button className="primary" disabled={!types.length}
          onClick={() => setF({ id: null, name: "", type: types[0]?.type ?? "", enabled: true, min_level: "warning", config: { send_recovery: true } })}>
          Додати канал
        </button>
        <span className="info">Інтерфейс показує всі тривоги завжди. Тут додаткові канали, куди тривоги надсилаються також.</span>
      </div>

      {f && (
        <div className="panel" style={{ maxWidth: 640 }}>
          <div className="form-row">
            <label>Тип</label>
            <select value={f.type} disabled={f.id !== null} onChange={(e) => setF({ ...f, type: e.target.value, config: { send_recovery: true } })}>
              {types.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}
            </select>
          </div>
          <div className="form-row"><label>Назва</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ flex: 1 }} /></div>
          {ft?.fields.map((fd) => (
            <div className="form-row" key={fd.key}>
              <label>{fd.label}</label>
              <input value={f.config[fd.key] ?? ""} type={fd.secret ? "password" : "text"} autoComplete="off"
                onChange={(e) => setF({ ...f, config: { ...f.config, [fd.key]: e.target.value } })} style={{ flex: 1 }} />
            </div>
          ))}
          <div className="form-row">
            <label>Надсилати від рівня</label>
            <select value={f.min_level} onChange={(e) => setF({ ...f, min_level: e.target.value as RuleLevel })}>
              {(["info", "warning", "alarm"] as RuleLevel[]).map((lv) => <option key={lv} value={lv}>{LEVEL_TEXT[lv]}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label />
            <label style={{ width: "auto" }}><input type="checkbox" checked={f.config.send_recovery !== false}
              onChange={(e) => setF({ ...f, config: { ...f.config, send_recovery: e.target.checked } })} /> повідомляти про повернення в норму</label>
            <label style={{ width: "auto" }}><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> увімкнено</label>
          </div>
          <div className="toolbar">
            <button className="primary" disabled={!f.name.trim()} onClick={save}>Зберегти</button>
            <button onClick={() => setF(null)}>Скасувати</button>
          </div>
        </div>
      )}

      <table className="grid">
        <thead><tr><th>Назва</th><th>Тип</th><th>Від рівня</th><th>Стан</th><th>Остання помилка</th><th /></tr></thead>
        <tbody>
          <tr><td>Інтерфейс</td><td>вбудований</td><td>усі</td><td className="ok">завжди увімкнено</td><td /><td /></tr>
          {(list.data ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{typeOf(c.type)?.title ?? c.type}</td>
              <td>{LEVEL_TEXT[c.min_level]}</td>
              <td className={c.enabled ? "ok" : "muted"}>{c.enabled ? "увімкнено" : "вимкнено"}</td>
              <td className={"wrap " + (c.last_error ? "alarm" : "")}>{c.last_error}</td>
              <td>
                <button className="small" onClick={() => setF({ id: c.id, name: c.name, type: c.type, enabled: c.enabled, min_level: c.min_level, config: c.config })}>Змінити</button>{" "}
                <button className="small" onClick={() => test(c)}>Перевірити</button>{" "}
                <button className="small danger" onClick={() => del(c)}>Видалити</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
