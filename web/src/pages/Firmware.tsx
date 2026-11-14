import { useRef, useState } from "react";
import { api, Firmware } from "../api";
import { fmtBytes, fmtTime } from "../format";
import { useFetch } from "../hooks";
import { useLive } from "../live";
import { toast, toastError } from "../toast";

export function FirmwarePage() {
  const l = useLive();
  const list = useFetch<Firmware[]>("/firmware");
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) return;
    const form = new FormData();
    form.append("file", f);
    form.append("note", note);
    setBusy(true);
    try {
      const r = await api<Firmware>("/firmware", { method: "POST", form });
      toast(`Завантажено: ${r.chip} ${r.version}`);
      setNote("");
      if (file.current) file.current.value = "";
      list.reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function del(f: Firmware) {
    if (!confirm(`Видалити прошивку ${f.version}?`)) return;
    await api(`/firmware/${f.id}`, { method: "DELETE" }).catch(toastError);
    list.reload();
  }

  const mods = [...l.modules.values()];
  return (
    <>
      <div className="toolbar">
        <input type="file" accept=".bin" ref={file} />
        <input placeholder="Примітка" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 260 }} />
        <button className="primary" disabled={busy} onClick={upload}>Завантажити</button>
        <span className="info">Файл застосунку з папки build/ (не merged-образ). Чип і версія читаються з файла.</span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Чип</th><th>Версія</th><th>Файл</th><th>Проєкт</th><th>ESP-IDF</th><th>Зібрано</th><th className="num">Розмір</th>
            <th className="num">Модулів на ній</th><th>SHA-256</th><th>Примітка</th><th>Завантажено</th><th />
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((f) => (
            <tr key={f.id}>
              <td>{f.chip}</td>
              <td>{f.version}</td>
              <td>{f.filename}</td>
              <td>{f.project}</td>
              <td>{f.idf}</td>
              <td>{f.build_time}</td>
              <td className="num">{fmtBytes(f.size)}</td>
              <td className="num">{mods.filter((m) => m.chip === f.chip && m.fw === f.version).length}</td>
              <td className="mono" title={f.sha256}>{f.sha256.slice(0, 12)}…</td>
              <td className="wrap">{f.note}</td>
              <td>{fmtTime(f.uploaded_at)}</td>
              <td><button className="small danger" onClick={() => del(f)}>Видалити</button></td>
            </tr>
          ))}
          {list.data?.length === 0 && <tr><td colSpan={12} className="muted">Прошивок ще немає</td></tr>}
        </tbody>
      </table>
      <p className="note">Оновлення запускається на сторінці модуля, у таблиці модулів (для вибраних) або на сторінці груп.</p>
    </>
  );
}
