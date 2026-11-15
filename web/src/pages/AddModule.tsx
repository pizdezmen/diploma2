import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, Firmware, Group } from "../api";
import { useFetch } from "../hooks";
import { live } from "../live";
import { detectChip, ESPRESSIF_VID, flashImage, LineLink, reopenPort, resetAndClose, serialSupported } from "../serial";

interface Wifi {
  ssid: string;
  pass: string;
}
interface Provisioning {
  server_url: string;
  mqtt_host: string;
  mqtt_port: number;
  mqtt_tls: boolean;
  token: string;
}

// v2: попередня версія могла зберегти підставлені браузером логін і пароль сайту замість Wi-Fi
const STORE_KEY = "dm.addModule.wifi.v2";
const CHIP_TITLE: Record<string, string> = { esp32s3: "ESP32-S3", esp32c3: "ESP32-C3" };

function loadWifi(): Wifi[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (Array.isArray(v) && v.length === 2) return v;
  } catch {
    /* */
  }
  return [{ ssid: "", pass: "" }, { ssid: "", pass: "" }];
}

type Step = "idle" | "port" | "detect" | "download" | "flash" | "reboot" | "config" | "wait" | "done" | "error";
const STEP_TEXT: Record<Step, string> = {
  idle: "",
  port: "Вибір порту",
  detect: "Підключення до плати і визначення чипа",
  download: "Завантаження прошивки з сервера",
  flash: "Прошивання",
  reboot: "Перезапуск плати",
  config: "Запис налаштувань у модуль",
  wait: "Очікування, поки модуль підключиться до сервера",
  done: "Готово",
  error: "Помилка",
};

export function AddModulePage() {
  const groups = useFetch<{ groups: Group[] }>("/groups");
  const firmware = useFetch<Firmware[]>("/firmware");
  const prov = useFetch<Provisioning>("/provisioning");
  const [wifi, setWifi] = useState<Wifi[]>(loadWifi);
  const [remember, setRemember] = useState(true);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [eraseAll, setEraseAll] = useState(false);
  const [skipFlash, setSkipFlash] = useState(false);
  const [allPorts, setAllPorts] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState<{ chip?: string; fw?: string; id?: string; image?: string }>({});
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const addLog = (t: string) => setLog((l) => [...l.slice(-300), t]);
  const busy = !["idle", "done", "error"].includes(step);
  const fulls = (firmware.data ?? []).filter((f) => f.kind === "full");
  const latest = (chip: string) =>
    fulls.filter((f) => f.chip === chip).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))[0];

  async function run() {
    if (!prov.data) return;
    const nets = wifi.filter((w) => w.ssid.trim());
    try {
      if (remember) localStorage.setItem(STORE_KEY, JSON.stringify(wifi));
      else localStorage.removeItem(STORE_KEY);
    } catch {
      /* */
    }
    setError("");
    setHint("");
    setLog([]);
    setInfo({});
    setProgress(0);
    let port: SerialPort | null = null;
    let link: LineLink | null = null;
    try {
      setStep("port");
      port = await navigator.serial.requestPort(allPorts ? {} : { filters: [{ usbVendorId: ESPRESSIF_VID }] });

      if (!skipFlash) {
        setStep("detect");
        const { chip, loader, transport } = await detectChip(port, { log: addLog, progress: setProgress });
        setInfo((i) => ({ ...i, chip }));
        const fw = latest(chip);
        if (!fw) {
          await transport.disconnect().catch(() => {});
          throw new Error(`На сервері немає повного образу для ${CHIP_TITLE[chip] ?? chip}. Завантажте його на сторінці «Прошивки».`);
        }
        setInfo((i) => ({ ...i, image: `${fw.version} (${fw.filename})` }));
        setStep("download");
        const res = await fetch(`/api/firmware/${fw.id}/file`, { credentials: "same-origin" });
        if (!res.ok) throw new Error("Не вдалося завантажити прошивку з сервера");
        const data = new Uint8Array(await res.arrayBuffer());
        setStep("flash");
        await flashImage(loader, data, eraseAll, { log: addLog, progress: setProgress });
        setStep("reboot");
        await resetAndClose(loader, transport);
        await new Promise((r) => setTimeout(r, 1500));
        port = await reopenPort(port);
      } else {
        await port.open({ baudRate: 115200 });
      }

      setStep("config");
      link = new LineLink(port, addLog);
      link.start();
      // Чекаємо відповіді на info до 75 с. Через 15 с просимо натиснути RST: якщо плата лишилась у завантажувачі,
      // кнопка запускає прошивку. Після RST плата може заново підключитися до USB, тоді відкриваємо порт ще раз.
      let hello: any = null;
      const t0 = Date.now();
      while (!hello && Date.now() - t0 < 75000) {
        if (!link.alive) {
          await link.close();
          addLog("Порт закрився, підключаюся знову…");
          port = await reopenPort(port, 20000);
          link = new LineLink(port, addLog);
          link.start();
        }
        hello = await link.request({ cmd: "info" }, 1000, 3000).catch(() => null);
        if (!hello && Date.now() - t0 > 15000) setHint("Модуль не відповідає. Натисніть на платі кнопку RST (або RESET/EN) один раз і зачекайте.");
      }
      setHint("");
      if (!hello?.ok)
        throw new Error(
          "Модуль не відповідає на команду info. Натисніть RST на платі і спробуйте ще раз з позначкою «Не прошивати, лише записати налаштування». Якщо не допоможе, на платі може бути прошивка без налаштування через USB.",
        );
      setInfo((i) => ({ ...i, id: hello.id, chip: hello.chip, fw: hello.fw }));
      const existing = live.modules.get(hello.id);
      if (existing?.provisioned) {
        addLog(`Модуль ${hello.id} уже є на сервері: скидаю його пароль MQTT для повторної реєстрації`);
        await api(`/modules/${hello.id}/reset-credentials`, { method: "POST" });
      }
      const p = prov.data;
      const r = await link.request(
        {
          cmd: "provision",
          wifi: nets.map((w) => ({ ssid: w.ssid.trim(), pass: w.pass })),
          server_url: p.server_url,
          mqtt_host: p.mqtt_host,
          mqtt_port: p.mqtt_port,
          mqtt_tls: p.mqtt_tls,
          token: p.token,
        },
        5000,
        10000,
      );
      if (!r) throw new Error("Модуль не відповів на запис налаштувань");
      if (!r.ok) throw new Error(`Модуль відхилив налаштування: ${r.error}`);
      await link.close();
      link = null;

      setStep("wait");
      const id: string = hello.id;
      const started = Date.now();
      // модуль перезапускається, підключається до Wi-Fi, реєструється і надсилає status online
      while (Date.now() - started < 120000) {
        const m = live.modules.get(id);
        if (m?.online && m.provisioned && m.last_status_at && Date.parse(m.last_status_at) > started - 5000) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      const m = live.modules.get(id);
      if (!m?.online) {
        throw new Error(
          "Налаштування записано, але модуль за 2 хвилини не з'явився на зв'язку. Перевірте назву і пароль Wi-Fi та чи доступна мережа.",
        );
      }
      if (name.trim() || group) {
        const body: any = {};
        if (name.trim()) body.name = name.trim();
        if (group) body.group_id = Number(group);
        await api(`/modules/${id}`, { method: "PATCH", body });
      }
      setStep("done");
    } catch (e: any) {
      if (e?.name === "NotFoundError") {
        setStep("idle"); // користувач закрив вікно вибору порту
        return;
      }
      setHint("");
      setError(e?.message || String(e));
      setStep("error");
    } finally {
      if (link) await link.close();
    }
  }

  if (!serialSupported()) {
    return (
      <div className="panel" style={{ maxWidth: 700 }}>
        Прошивання з сайту працює лише в Chrome або Edge на комп'ютері (потрібен Web Serial), і сайт має бути відкритий по https
        або з localhost.
      </div>
    );
  }

  const canRun = !busy && prov.data && wifi[0].ssid.trim() && (skipFlash || fulls.length > 0);
  return (
    <div style={{ maxWidth: 900 }}>
      <h1>Додати модуль</h1>
      <p className="note">
        Підключіть плату ESP32-S3 або ESP32-C3 кабелем USB до цього комп'ютера. Сайт сам визначить тип плати, запише останню прошивку
        і налаштування, після чого модуль з'явиться в таблиці.
      </p>

      <h2>Wi-Fi для модуля</h2>
      <div className="panel">
        <p className="note" style={{ marginTop: 0 }}>
          Мережа, до якої підключатиметься плата (не логін і пароль цього сайту). Плати ESP32 працюють лише з Wi-Fi 2,4 ГГц.
        </p>
        {wifi.map((w, i) => (
          <div className="form-row" key={i}>
            <label>{i === 0 ? "Основна мережа" : "Запасна мережа"}</label>
            <NoAutofill placeholder="Назва мережі Wi-Fi (SSID)" value={w.ssid} disabled={busy} name={`dm-wifi-ssid-${i}`}
              onChange={(v) => setWifi(wifi.map((x, j) => (j === i ? { ...x, ssid: v } : x)))} />
            <NoAutofill placeholder="Пароль Wi-Fi" secret value={w.pass} disabled={busy} name={`dm-wifi-key-${i}`}
              onChange={(v) => setWifi(wifi.map((x, j) => (j === i ? { ...x, pass: v } : x)))} />
            <span className="note">{i === 0 ? "обов'язково" : "необов'язково, якщо основна недоступна"}</span>
          </div>
        ))}
        <label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Запам'ятати мережі в цьому браузері</label>
      </div>

      <h2>Модуль</h2>
      <div className="panel">
        <div className="form-row"><label>Назва</label><input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="необов'язково" style={{ width: 300 }} /></div>
        <div className="form-row">
          <label>Група</label>
          <select value={group} disabled={busy} onChange={(e) => setGroup(e.target.value)} style={{ width: 300 }}>
            <option value="">Без групи</option>
            {groups.data?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div><label><input type="checkbox" checked={eraseAll} disabled={busy || skipFlash} onChange={(e) => setEraseAll(e.target.checked)} /> Стерти всю пам'ять плати перед записом (довше)</label></div>
        <div><label><input type="checkbox" checked={skipFlash} disabled={busy} onChange={(e) => setSkipFlash(e.target.checked)} /> Не прошивати, лише записати налаштування (на платі вже наша прошивка)</label></div>
        <div><label><input type="checkbox" checked={allPorts} disabled={busy} onChange={(e) => setAllPorts(e.target.checked)} /> Показувати всі COM-порти, не лише плати Espressif</label></div>
      </div>

      <h2>Прошивки на сервері</h2>
      <table className="grid kv">
        <tbody>
          {["esp32s3", "esp32c3"].map((c) => {
            const f = latest(c);
            return (
              <tr key={c}>
                <th>{CHIP_TITLE[c]}</th>
                <td className={f ? "" : "warn"}>{f ? `${f.version} (${f.filename})` : "немає повного образу"}</td>
              </tr>
            );
          })}
          <tr><th>Сервер для модуля</th><td className="mono">{prov.data ? `${prov.data.server_url}, MQTT ${prov.data.mqtt_host}:${prov.data.mqtt_port}${prov.data.mqtt_tls ? " TLS" : ""}` : "…"}</td></tr>
        </tbody>
      </table>
      {fulls.length === 0 && !skipFlash && (
        <p className="note">Спершу завантажте повний образ (файл з idf.py merge-bin) на сторінці <Link to="/firmware">«Прошивки»</Link>.</p>
      )}

      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!canRun} onClick={run}>{skipFlash ? "Вибрати порт і записати налаштування" : "Вибрати порт і прошити"}</button>
        {step !== "idle" && (
          <span className={step === "error" ? "err" : "info"}>
            {STEP_TEXT[step]}
            {step === "flash" && ` ${progress}%`}
          </span>
        )}
      </div>
      {step === "flash" && <div className="progress" style={{ width: 400, height: 10 }}><div style={{ width: `${progress}%` }} /></div>}

      {(info.chip || info.id) && (
        <table className="grid kv" style={{ marginTop: 10 }}>
          <tbody>
            {info.chip && <tr><th>Чип</th><td>{CHIP_TITLE[info.chip] ?? info.chip}</td></tr>}
            {info.image && <tr><th>Записано прошивку</th><td>{info.image}</td></tr>}
            {info.id && <tr><th>ID модуля</th><td className="mono">{info.id}</td></tr>}
            {info.fw && <tr><th>Версія на модулі</th><td>{info.fw}</td></tr>}
          </tbody>
        </table>
      )}
      {step === "done" && info.id && (
        <p className="ok-text">Модуль на зв'язку. <Link to={`/modules/${info.id}`}>Відкрити модуль</Link>. Можна підключати наступну плату.</p>
      )}
      {hint && <div className="panel" style={{ borderColor: "var(--warn)", color: "var(--warn)", marginTop: 8 }}>{hint}</div>}
      {error && <div className="err">{error}</div>}
      {log.length > 0 && (
        <>
          <h2>Журнал</h2>
          <pre ref={logRef} className="log">{log.join("\n")}</pre>
        </>
      )}
    </div>
  );
}

/** Поле, яке менеджер паролів браузера не сприймає як логін або пароль сайту. */
function NoAutofill(props: { value: string; onChange: (v: string) => void; placeholder: string; name: string; disabled?: boolean; secret?: boolean }) {
  // readOnly до фокусу: Chrome і менеджери паролів не заповнюють такі поля під час завантаження сторінки
  const [ro, setRo] = useState(true);
  const [show, setShow] = useState(false);
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <input
        type={props.secret && !show ? "password" : "text"}
        name={props.name}
        autoComplete={props.secret ? "new-password" : "off"}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        readOnly={ro}
        onFocus={() => setRo(false)}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ width: 220 }}
      />
      {props.secret && (
        <button type="button" className="small" onClick={() => setShow(!show)} title={show ? "Сховати" : "Показати"}>
          {show ? "Сховати" : "Показати"}
        </button>
      )}
    </span>
  );
}
