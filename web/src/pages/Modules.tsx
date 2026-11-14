import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Firmware, Group, Module } from "../api";
import { fmtAgo, fmtValue, Level, linkState, moduleTitle, valueLevel } from "../format";
import { useFetch, useNow } from "../hooks";
import { useLive } from "../live";
import { toast, toastError } from "../toast";

type SortKey = "state" | "name" | "id" | "group" | "chip" | "fw" | "rssi" | "chip_temp_c" | "uptime_s" | "heap_free" | "seen";

export function ModulesPage() {
  const l = useLive();
  const now = useNow();
  const groups = useFetch<{ groups: Group[] }>("/groups");
  const firmware = useFetch<Firmware[]>("/firmware");
  const [q, setQ] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fwId, setFwId] = useState("");
  const [targetGroup, setTargetGroup] = useState("");

  const groupName = useMemo(() => {
    const m = new Map<number, string>();
    groups.data?.groups.forEach((g) => m.set(g.id, g.name));
    return m;
  }, [groups.data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = [...l.modules.values()].filter((m) => {
      if (needle && ![m.name, m.id, m.ip, m.fw, m.note].some((x) => x && x.toLowerCase().includes(needle))) return false;
      if (groupFilter === "none" && m.group_id !== null) return false;
      if (groupFilter !== "all" && groupFilter !== "none" && String(m.group_id) !== groupFilter) return false;
      const st = linkState(m, now).level;
      if (stateFilter === "online" && st !== "ok") return false;
      if (stateFilter === "problem" && st === "ok") return false;
      return true;
    });
    const key = (m: Module): any => {
      switch (sort.key) {
        case "state": return ["ok", "warn", "alarm"].indexOf(linkState(m, now).level);
        case "name": return moduleTitle(m).toLowerCase();
        case "id": return m.id;
        case "group": return m.group_id ? groupName.get(m.group_id) ?? "" : "";
        case "chip": return m.chip ?? "";
        case "fw": return m.fw ?? "";
        case "seen": return m.last_seen_at ?? "";
        default: return m.last_values?.[sort.key] ?? -Infinity;
      }
    };
    list.sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sort.dir;
    });
    return list;
  }, [l.version, q, groupFilter, stateFilter, sort, now, groupName]);

  const selIds = [...selected].filter((id) => l.modules.has(id));
  const allSelected = rows.length > 0 && rows.every((m) => selected.has(m.id));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((m) => m.id)));
  }
  function toggle(id: string) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  }

  async function bulk(name: string, params: any = {}) {
    try {
      const r = await api("/commands/bulk", { method: "POST", body: { module_ids: selIds, name, params } });
      let msg = `Надіслано: ${r.queued}`;
      if (r.offline.length) msg += `, не на зв'язку: ${r.offline.length}`;
      if (r.skipped.length) msg += `, пропущено: ${r.skipped.length} (${r.skipped[0].reason})`;
      toast(msg, r.skipped.length > 0);
    } catch (e) {
      toastError(e);
    }
  }

  async function assignGroup() {
    const gid = targetGroup === "none" ? null : Number(targetGroup);
    try {
      for (const id of selIds) await api(`/modules/${id}`, { method: "PATCH", body: { group_id: gid } });
      toast(`Групу змінено для ${selIds.length} модулів`);
      groups.reload();
    } catch (e) {
      toastError(e);
    }
  }

  const th = (key: SortKey, label: string, num = false) => (
    <th className={"sort" + (num ? " num" : "")} onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  const cell = (m: Module, metric: string) => {
    const v = m.last_values?.[metric];
    const stale = !m.online;
    const lvl: Level = stale ? "none" : valueLevel(metric, v);
    return (
      <td className={"num " + (lvl === "warn" || lvl === "alarm" ? lvl : "") + (stale ? " muted" : "")}>{fmtValue(metric, v)}</td>
    );
  };

  return (
    <>
      <div className="toolbar">
        <input placeholder="Пошук: назва, ID, IP, версія" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="all">Усі групи</option>
          <option value="none">Без групи</option>
          {groups.data?.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="all">Будь-який стан</option>
          <option value="online">На зв'язку</option>
          <option value="problem">З проблемами</option>
        </select>
        <span className="info">Показано {rows.length} з {l.modules.size}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <Link to="/add"><button className="primary">Додати модуль</button></Link>
      </div>

      <div className="toolbar">
        <span className="info">Вибрано: {selIds.length}</span>
        <span className="sep" />
        <span className="seg">
          <button disabled={!selIds.length} onClick={() => bulk("led", { mode: "on" })}>Світлодіод увімк.</button>
          <button disabled={!selIds.length} onClick={() => bulk("led", { mode: "blink" })}>Блимати</button>
          <button disabled={!selIds.length} onClick={() => bulk("led", { mode: "off" })}>Вимк.</button>
        </span>
        <button disabled={!selIds.length} onClick={() => confirm(`Перезапустити ${selIds.length} модулів?`) && bulk("restart")}>Перезапустити</button>
        <span className="sep" />
        <select value={fwId} onChange={(e) => setFwId(e.target.value)}>
          <option value="">Прошивка…</option>
          {firmware.data?.filter((f) => f.kind === "app").map((f) => (
            <option key={f.id} value={f.id}>{f.chip} {f.version} ({f.filename})</option>
          ))}
        </select>
        <button
          disabled={!selIds.length || !fwId}
          onClick={() => confirm(`Оновити прошивку на ${selIds.length} модулях? Оновлення йде хвилями.`) && bulk("ota", { firmware_id: Number(fwId) })}
        >
          Оновити прошивку
        </button>
        <span className="sep" />
        <select value={targetGroup} onChange={(e) => setTargetGroup(e.target.value)}>
          <option value="">Група…</option>
          <option value="none">Без групи</option>
          {groups.data?.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button disabled={!selIds.length || !targetGroup} onClick={assignGroup}>Призначити групу</button>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
            {th("state", "Стан")}
            {th("name", "Назва")}
            {th("id", "ID (MAC)")}
            {th("group", "Група")}
            {th("chip", "Чип")}
            {th("fw", "Прошивка")}
            {th("rssi", "Wi-Fi", true)}
            {th("chip_temp_c", "Темп. чипа", true)}
            {th("uptime_s", "Час роботи", true)}
            {th("heap_free", "Вільна пам'ять", true)}
            <th className="num">Інтервал</th>
            {th("seen", "Останні дані")}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const st = linkState(m, now);
            return (
              <tr key={m.id} className={selected.has(m.id) ? "selected" : ""}>
                <td><input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} /></td>
                <td className={st.level}>
                  {st.text}
                  {m.provision_denied_at && m.provisioned && <span className="badge warn" title="Модуль втратив пароль і просить новий. Відкрийте модуль і скиньте пароль MQTT."> пароль</span>}
                </td>
                <td><Link to={`/modules/${m.id}`}>{moduleTitle(m)}</Link></td>
                <td className="mono">{m.id}</td>
                <td>{m.group_id ? groupName.get(m.group_id) ?? "" : <span className="muted">—</span>}</td>
                <td>{m.chip ?? "—"}</td>
                <td>{m.fw ?? "—"}</td>
                {cell(m, "rssi")}
                {cell(m, "chip_temp_c")}
                {cell(m, "uptime_s")}
                {cell(m, "heap_free")}
                <td className="num">{m.interval_s ? `${m.interval_s} с` : <span className="muted">{m.group_id ? "як у групи" : "типовий"}</span>}</td>
                <td>{fmtAgo(m.last_seen_at, now)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={13} className="muted">
                {l.modules.size === 0 ? "Модулів ще немає. Натисніть «Додати модуль», щоб прошити й підключити плату через USB." : "Нічого не знайдено"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
