import { useEffect } from "react";
import { Link } from "react-router-dom";
import { EventRow } from "../api";
import { fmtTime, moduleTitle } from "../format";
import { useFetch } from "../hooks";
import { useLive } from "../live";

export function EventsPage() {
  const l = useLive();
  const ev = useFetch<EventRow[]>("/events?limit=300");
  useEffect(() => {
    const t = setInterval(() => ev.reload(), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <table className="grid">
      <thead><tr><th>Час</th><th>Модуль</th><th>Подія</th></tr></thead>
      <tbody>
        {(ev.data ?? []).map((e) => {
          const m = e.module_id ? l.modules.get(e.module_id) : undefined;
          return (
            <tr key={e.id}>
              <td>{fmtTime(e.time)}</td>
              <td>{e.module_id ? <Link to={`/modules/${e.module_id}`}>{m ? moduleTitle(m) : e.module_id}</Link> : "—"}</td>
              <td className={e.level === "warning" ? "warn" : e.level === "alarm" ? "alarm" : ""}>{e.message}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
