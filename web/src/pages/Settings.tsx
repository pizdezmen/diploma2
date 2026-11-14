import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { toast, toastError } from "../toast";

interface S {
  retention_raw_days: number | null;
  retention_1m_days: number | null;
  retention_1h_days: number | null;
  default_interval_s: number;
  ota_wave_size: number;
}

export function SettingsPage() {
  const s = useFetch<S>("/settings");
  const sys = useFetch<any>("/system");
  const [f, setF] = useState<Record<keyof S, string> | null>(null);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    if (s.data) {
      const d = s.data;
      setF({
        retention_raw_days: d.retention_raw_days?.toString() ?? "",
        retention_1m_days: d.retention_1m_days?.toString() ?? "",
        retention_1h_days: d.retention_1h_days?.toString() ?? "",
        default_interval_s: String(d.default_interval_s),
        ota_wave_size: String(d.ota_wave_size),
      });
    }
  }, [s.data]);

  useEffect(() => {
    const t = setInterval(() => sys.reload(), 5000);
    return () => clearInterval(t);
  }, []);

  async function save() {
    if (!f) return;
    const n = (x: string) => (x.trim() === "" ? null : Number(x));
    try {
      const r = await api<S>("/settings", {
        method: "PUT",
        body: {
          retention_raw_days: n(f.retention_raw_days),
          retention_1m_days: n(f.retention_1m_days),
          retention_1h_days: n(f.retention_1h_days),
          default_interval_s: Number(f.default_interval_s),
          ota_wave_size: Number(f.ota_wave_size),
        },
      });
      s.setData(r);
      toast("Збережено");
    } catch (e) {
      toastError(e);
    }
  }

  const field = (k: keyof S, label: string, hint: string) =>
    f && (
      <div className="form-row">
        <label style={{ width: 260 }}>{label}</label>
        <input type="number" min={1} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ width: 100 }} />
        <span className="note">{hint}</span>
      </div>
    );

  const y = sys.data;
  return (
    <div style={{ maxWidth: 900 }}>
      <h2>Зберігання історії</h2>
      <div className="panel">
        {field("retention_raw_days", "Сирі дані, днів", "за замовчуванням 7; порожньо = без обмеження")}
        {field("retention_1m_days", "Середні за хвилину, днів", "за замовчуванням 90")}
        {field("retention_1h_days", "Середні за годину, днів", "за замовчуванням порожньо (без обмеження)")}
        <h2>Модулі</h2>
        {field("default_interval_s", "Типовий інтервал надсилання, с", "для модулів без власного інтервалу і без інтервалу групи")}
        {field("ota_wave_size", "Оновлення прошивки: модулів у хвилі", "наступна хвиля стартує, коли завершиться попередня")}
        <button className="primary" onClick={save}>Зберегти</button>
      </div>

      <h2>Підключення модулів</h2>
      <table className="grid kv">
        <tbody>
          <tr><th>Брокер MQTT</th><td className={y?.mqtt_connected ? "ok" : "alarm"}>{y ? (y.mqtt_connected ? "сервер підключений" : "немає зв'язку") : "…"}</td></tr>
          <tr><th>Порт MQTT для модулів</th><td>{y?.mqtt_public_port} {y?.mqtt_tls ? "(TLS)" : "(без TLS)"}</td></tr>
          <tr><th>Адреса сервера (SERVER_URL)</th><td className="mono">{y?.public_url}</td></tr>
          <tr>
            <th>Токен реєстрації</th>
            <td className="mono">
              {showToken ? y?.provision_token : "••••••••"}{" "}
              <button className="small" onClick={() => setShowToken(!showToken)}>{showToken ? "Сховати" : "Показати"}</button>
            </td>
          </tr>
          <tr><th>Модулів / на зв'язку</th><td>{y?.modules} / {y?.online}</td></tr>
          <tr><th>Прийнято повідомлень</th><td>{y?.stats?.messages}</td></tr>
          <tr><th>Записано показників</th><td>{y?.stats?.rows}</td></tr>
          <tr><th>У буфері запису</th><td>{y?.buffer}</td></tr>
        </tbody>
      </table>
      <p className="note">Логін і пароль входу, паролі бази й брокера, TLS і адреса сервера задаються у файлі .env на сервері.</p>
    </div>
  );
}
