import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Batch, Firmware, Group, Module } from "../api";
import { CHIP_SHORT, CMD_STATUS, compareVersions, fmtAgo, fmtValue, Level, linkState, metricLabel, metricLevel, moduleTitle } from "../format";
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
  const [fwVersion, setFwVersion] = useState("");
  const [targetGroup, setTargetGroup] = useState("");
  const [batch, setBatch] = useState<Batch | null>(null);

  // Версії прошивок (файли застосунку для OTA) і для яких чипів кожна є
  const fwInfo = useMemo(() => {
    const chips = new Map<string, Set<string>>();
    const latest = new Map<string, string>();
    for (const f of firmware.data ?? []) {
      if (f.kind !== "app") continue;
      if (!chips.has(f.version)) chips.set(f.version, new Set());
      chips.get(f.version)!.add(f.chip);
      const cur = latest.get(f.chip);
      if (!cur || compareVersions(f.version, cur) > 0) latest.set(f.chip, f.version);
    }
    const versions = [...chips.keys()].sort((a, b) => compareVersions(b, a));
    return { chips, latest, versions };
  }, [firmware.data]);

  const newerFw = (m: Module): string | null => {
    const v = m.chip ? fwInfo.latest.get(m.chip) : undefined;
    return v && m.fw && compareVersions(v, m.fw) > 0 ? v : null;
  };

  // Після відкриття сторінки підхоплюємо незавершене оновлення
  useEffect(() => {
    api<Batch[]>("/commands/batches?name=ota")
      .then((list) => {
        const active = list.find((b) => !b.finished);
        if (active) return api<Batch>(`/commands/batches/${active.id}`).then(setBatch);
      })
      .catch(() => {});
  }, []);

  // Поки оновлення йде, раз на 2 с читаємо стан кожного модуля
  useEffect(() => {
    if (!batch || batch.finished) return;
    const t = setTimeout(() => {
      api<Batch>(`/commands/batches/${batch.id}`).then(setBatch).catch(() => setBatch({ ...batch, finished: true }));
    }, 2000);
    return () => clearTimeout(t);
  }, [batch]);

  const batchState = useMemo(() => {
    const m = new Map<string, { state: string; message: string; progress: number | null }>();
    batch?.items?.forEach((it) => m.set(it.module_id, it));
    return m;
  }, [batch]);

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
      if (stateFilter === "problem" && st === "ok" && !(m.online && m.alarms?.length)) return false;
      if (stateFilter === "outdated" && !newerFw(m)) return false;
      if (stateFilter === "batch" && !batchState.has(m.id)) return false;
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
  }, [l.version, q, groupFilter, stateFilter, sort, now, groupName, fwInfo, batchState]);

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

  async function updateSelected() {
    const v = fwVersion;
    const sel = selIds.map((id) => l.modules.get(id)!).filter(Boolean);
    const same = sel.filter((m) => m.fw === v).length;
    const noFile = sel.filter((m) => m.fw !== v && !(m.chip && fwInfo.chips.get(v)?.has(m.chip))).length;
    const go = sel.length - same - noFile;
    let text = `Оновити ${go} модулів до ${v}? Модулі оновлюються по черзі: наступний стартує, коли попередній перезапуститься з новою версією.`;
    if (same) text += `\nВже на ${v}: ${same} (пропустимо).`;
    if (noFile) text += `\nНемає файла ${v} для їхнього чипа: ${noFile} (пропустимо).`;
    if (!go) return toast(`Немає модулів, які можна оновити до ${v}`, true);
    if (!confirm(text)) return;
    try {
      const r = await api("/commands/bulk", { method: "POST", body: { module_ids: selIds, name: "ota", params: { version: v } } });
      setBatch(await api<Batch>(`/commands/batches/${r.batch_id}`));
    } catch (e) {
      toastError(e);
    }
  }

  async function cancelBatch() {
    if (!batch || !confirm("Зупинити оновлення? Модуль, що вже оновлюється, завершить оновлення, решта залишиться як є.")) return;
    try {
      setBatch(await api<Batch>(`/commands/batches/${batch.id}/cancel`, { method: "POST" }));
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
    const lvl: Level = metricLevel(m, metric);
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
          <option value="outdated">Є нова прошивка</option>
          {batch && <option value="batch">В останньому оновленні</option>}
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
        <select value={fwVersion} onChange={(e) => setFwVersion(e.target.value)} title="Файл під чип (S3 або C3) сайт підбере сам">
          <option value="">Версія прошивки…</option>
          {fwInfo.versions.map((v) => (
            <option key={v} value={v}>
              {v} ({[...fwInfo.chips.get(v)!].map((c) => CHIP_SHORT[c] ?? c).sort().join(", ")})
            </option>
          ))}
        </select>
        <button disabled={!selIds.length || !fwVersion || (batch !== null && !batch.finished)} onClick={updateSelected}>
          Оновити вибрані
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

      {batch && <BatchPanel batch={batch} onCancel={cancelBatch} onClose={() => { setBatch(null); if (stateFilter === "batch") setStateFilter("all"); }} />}

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
            {batch && <th>Оновлення</th>}
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
                  {m.online && m.alarms?.length > 0 && <span className="badge alarm" title={"Поза нормою: " + m.alarms.map(metricLabel).join(", ")}> тривога</span>}
                  {m.provision_denied_at && m.provisioned && <span className="badge warn" title="Модуль втратив пароль і просить новий. Відкрийте модуль і скиньте пароль MQTT."> пароль</span>}
                </td>
                <td><Link to={`/modules/${m.id}`}>{moduleTitle(m)}</Link></td>
                <td className="mono">{m.id}</td>
                <td>{m.group_id ? groupName.get(m.group_id) ?? "" : <span className="muted">—</span>}</td>
                <td>{m.chip ?? "—"}</td>
                <td>
                  {m.fw ?? "—"}
                  {newerFw(m) && <span className="badge info" title="Є новіша прошивка для цього чипа"> є {newerFw(m)}</span>}
                </td>
                {batch && <td><BatchCell it={batchState.get(m.id)} /></td>}
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
              <td colSpan={batch ? 14 : 13} className="muted">
                {l.modules.size === 0 ? "Модулів ще немає. Натисніть «Додати модуль», щоб прошити й підключити плату через USB." : "Нічого не знайдено"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function BatchCell({ it }: { it?: { state: string; message: string; progress: number | null } }) {
  if (!it) return <span className="muted">—</span>;
  const st = CMD_STATUS[it.state] ?? { text: it.state, level: "none" };
  return (
    <span className={st.level === "none" ? "muted" : st.level} title={it.message}>
      {it.state === "in_progress" && it.progress !== null && (
        <span className="progress"><div style={{ width: `${it.progress}%` }} /></span>
      )}
      {st.text}
      {(it.state === "error" || it.state === "timeout" || it.state === "skipped") && it.message ? `: ${it.message}` : ""}
    </span>
  );
}

function BatchPanel({ batch, onCancel, onClose }: { batch: Batch; onCancel: () => void; onClose: () => void }) {
  const c = batch.counts;
  const n = (k: string) => c[k] ?? 0;
  const ok = n("ok");
  const failed = n("error") + n("timeout");
  const running = n("sent") + n("in_progress");
  const waiting = n("waiting");
  const other = n("offline") + n("skipped") + n("cancelled");
  const work = batch.total - n("skipped");
  const done = ok + failed + n("offline") + n("cancelled");
  return (
    <div className="panel batch">
      <b>Оновлення до {batch.params?.version ?? "?"}</b>
      <span className="progress wide"><div style={{ width: `${work ? (done / work) * 100 : 100}%` }} /></span>
      <span className="ok-text">готово {ok}</span>
      {" з "}{work}
      {running > 0 && <span className="warn"> · оновлюється {running}</span>}
      {waiting > 0 && <span> · чекають {waiting}</span>}
      {failed > 0 && <span className="alarm"> · помилки {failed}</span>}
      {other > 0 && <span className="muted"> · пропущено {other}</span>}
      <span style={{ flex: 1 }} />
      {batch.finished ? (
        <>
          <span className="muted">Завершено{batch.cancelled ? " (зупинено)" : ""}</span>
          <button onClick={onClose}>Закрити</button>
        </>
      ) : (
        <button onClick={onCancel}>Зупинити</button>
      )}
    </div>
  );
}
