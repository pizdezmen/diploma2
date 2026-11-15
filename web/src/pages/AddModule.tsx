import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, Firmware, Group } from "../api";
import { useFetch } from "../hooks";
import { live } from "../live";
import { BoardInfo, detectChip, ESPRESSIF_VID, portKind, flashImage, LineLink, openForApp, probeBoard, reopenPort, resetAndClose, serialSupported } from "../serial";
import { fmtAgo, moduleTitle } from "../format";
import { useLive } from "../live";

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

/** Помилка, після якої треба ввести плату в режим прошивання кнопками і вибрати порт заново. */
class NeedBootMode extends Error {}
/** Прошивку записано, але порт після перезапуску треба вибрати вручну. */
class NeedPortAgain extends Error {}

interface KnownPort {
  port: SerialPort;
  state: "checking" | "ours" | "silent" | "error" | "factory" | "bootloader";
  info?: BoardInfo;
}

export function AddModulePage() {
  const l = useLive();
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
  const [help, setHelp] = useState<"" | "boot" | "port">("");
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

  const [ports, setPorts] = useState<KnownPort[]>([]);
  const busyRef = useRef(false);
  busyRef.current = busy;

  /** Перевіряє плати, до яких браузер уже має дозвіл: чи на них наша прошивка і чи вони вже в системі. */
  async function refreshPorts() {
    if (busyRef.current || !serialSupported()) return;
    const list = (await navigator.serial.getPorts()).filter((p) => allPorts || p.getInfo().usbVendorId === ESPRESSIF_VID);
    setPorts(list.map((port) => ({ port, state: "checking" })));
    for (const port of list) {
      if (busyRef.current) return;
      let item: KnownPort;
      const kind = portKind(port);
      if (kind === "other" || kind === "rom") {
        item = { port, state: kind === "rom" ? "bootloader" : "factory" };
        setPorts((cur) => cur.map((x) => (x.port === port ? item : x)));
        continue;
      }
      try {
        const info = await probeBoard(port);
        item = info ? { port, state: "ours", info } : { port, state: "silent" };
      } catch {
        item = { port, state: "error" };
      }
      setPorts((cur) => cur.map((x) => (x.port === port ? item : x)));
    }
  }

  useEffect(() => {
    if (!serialSupported()) return;
    refreshPorts();
    const onChange = () => setTimeout(refreshPorts, 1500);
    navigator.serial.addEventListener("connect", onChange);
    navigator.serial.addEventListener("disconnect", onChange);
    return () => {
      navigator.serial.removeEventListener("connect", onChange);
      navigator.serial.removeEventListener("disconnect", onChange);
    };
  }, [allPorts]);

  function boardStatus(k: KnownPort): { text: string; cls: string } {
    if (k.state === "checking") return { text: "перевіряю…", cls: "muted" };
    if (k.state === "error") return { text: "порт зайнятий іншою програмою", cls: "warn" };
    if (k.state === "factory") return { text: "заводська прошивка: перед прошиванням введіть плату в режим прошивання кнопками BOOT і RST", cls: "warn" };
    if (k.state === "bootloader") return { text: "у режимі прошивання, можна прошивати", cls: "ok" };
    if (k.state === "silent") return { text: "не відповідає: порожня плата, інша прошивка або потрібен RST", cls: "" };
    const m = k.info && l.modules.get(k.info.id);
    if (!m) return { text: "нова плата з нашою прошивкою, ще не в системі", cls: "" };
    return m.online
      ? { text: `уже в системі: ${moduleTitle(m)}, на зв'язку`, cls: "ok" }
      : { text: `уже в системі: ${moduleTitle(m)}, немає зв'язку (останні дані ${fmtAgo(m.last_seen_at)})`, cls: "warn" };
  }

  async function run(chosen?: SerialPort, skipOverride?: boolean) {
    if (!prov.data) return;
    let skip = skipOverride ?? skipFlash;
    const nets = wifi.filter((w) => w.ssid.trim());
    try {
      if (remember) localStorage.setItem(STORE_KEY, JSON.stringify(wifi));
      else localStorage.removeItem(STORE_KEY);
    } catch {
      /* */
    }
    setError("");
    setHint("");
    setHelp("");
    setLog([]);
    setInfo({});
    setProgress(0);
    let port: SerialPort | null = null;
    let link: LineLink | null = null;
    try {
      setStep("port");
      port = chosen ?? (await navigator.serial.requestPort(allPorts ? {} : { filters: [{ usbVendorId: ESPRESSIF_VID }] }));

      if (!skip) {
        // Якщо на платі вже остання прошивка, пропонуємо не перепрошувати
        const b = portKind(port) === "jtag" ? await probeBoard(port, 2500).catch(() => null) : null;
        if (b) {
          setInfo((i) => ({ ...i, id: b.id, chip: b.chip, fw: b.fw }));
          const fw = latest(b.chip);
          const m = live.modules.get(b.id);
          const where = m ? `Плата вже в системі як «${moduleTitle(m)}». ` : "";
          if (fw && fw.version === b.fw && confirm(`${where}На платі вже остання прошивка ${b.fw}. Не перепрошувати, лише записати налаштування?`)) {
            skip = true;
          }
        }
      }

      if (!skip) {
        setStep("detect");
        if (portKind(port) === "other") {
          addLog(`Плата видна як USB-пристрій ${port.getInfo().usbProductId?.toString(16)}: на ній заводська або чужа прошивка з власним USB`);
          throw new NeedBootMode("");
        }
        let det;
        try {
          det = await detectChip(port, { log: addLog, progress: setProgress });
        } catch (e: any) {
          addLog(String(e?.message || e));
          throw new NeedBootMode("");
        }
        const { chip, loader, transport } = det;
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
        // плата з USB Serial/JTAG після скидання може зникнути з USB на 1–3 с
        await new Promise((r) => setTimeout(r, 2500));
        try {
          port = await reopenPort(port);
        } catch {
          // з режиму завантажувача плата після RST з'являється як інший USB-пристрій, і браузер вимагає вибрати його знову
          throw new NeedPortAgain("");
        }
      } else {
        await openForApp(port);
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
          try {
            port = await reopenPort(port, 20000);
          } catch {
            throw new NeedPortAgain("");
          }
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
      setTimeout(refreshPorts, 500);
    } catch (e: any) {
      if (e?.name === "NotFoundError") {
        setStep("idle"); // користувач закрив вікно вибору порту
        return;
      }
      setHint("");
      if (e instanceof NeedBootMode) {
        setHelp("boot");
        setError("Плата не перейшла в режим прошивання сама.");
      } else if (e instanceof NeedPortAgain) {
        setHelp("port");
        setError("Прошивку записано, але сайт не знайшов плату після перезапуску.");
      } else {
        setError(e?.message || String(e));
      }
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

  const canConfigure = !busy && !!prov.data && !!wifi[0].ssid.trim();
  const canRun = canConfigure && (skipFlash || fulls.length > 0);
  return (
    <div style={{ maxWidth: 900 }}>
      <h1>Додати модуль</h1>
      <p className="note">
        Підключіть плату ESP32-S3 або ESP32-C3 кабелем USB до цього комп'ютера. Сайт сам визначить тип плати, запише останню прошивку
        і налаштування, після чого модуль з'явиться в таблиці.
      </p>
      <div className="panel" style={{ borderColor: "var(--warn)" }}>
        <b>Нова плата з пакета?</b> На ній заводська прошивка, і сама в режим прошивання вона не перейде. Перед тим як натиснути
        «Вибрати порт і прошити»: затисніть кнопку <b>BOOT</b>, коротко натисніть <b>RST</b>, відпустіть BOOT (або вставте кабель USB,
        тримаючи BOOT). Після прошивання натисніть RST ще раз. Плати, які вже прошивали з цього сайту, кнопок не потребують.
      </div>

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

      <h2>Плати, підключені до цього комп'ютера раніше</h2>
      <table className="grid">
        <thead>
          <tr><th>Порт</th><th>Плата</th><th>ID</th><th>Прошивка</th><th>Стан</th><th>Дії</th></tr>
        </thead>
        <tbody>
          {ports.map((k, i) => {
            const st = boardStatus(k);
            const pi = k.port.getInfo();
            const fw = k.info && latest(k.info.chip);
            return (
              <tr key={i}>
                <td className="mono">USB {pi.usbVendorId?.toString(16).padStart(4, "0")}:{pi.usbProductId?.toString(16).padStart(4, "0")}</td>
                <td>{k.info ? CHIP_TITLE[k.info.chip] ?? k.info.chip : "—"}</td>
                <td className="mono">{k.info ? (l.modules.has(k.info.id) ? <Link to={`/modules/${k.info.id}`}>{k.info.id}</Link> : k.info.id) : "—"}</td>
                <td>{k.info ? `${k.info.fw}${fw && fw.version !== k.info.fw ? ` (є ${fw.version})` : ""}` : "—"}</td>
                <td className={st.cls}>{st.text}</td>
                <td>
                  <button className="small" disabled={!canConfigure || fulls.length === 0 || k.state === "checking"} onClick={() => run(k.port, false)}>Прошити</button>{" "}
                  <button className="small" disabled={!canConfigure || k.state !== "ours"} onClick={() => run(k.port, true)}>Лише налаштування</button>
                </td>
              </tr>
            );
          })}
          {ports.length === 0 && (
            <tr><td colSpan={6} className="muted">Ще немає. Після першого вибору порту плата з'явиться тут, і сайт показуватиме, чи вона вже в системі.</td></tr>
          )}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button className="small" disabled={busy} onClick={refreshPorts}>Перевірити ще раз</button>
        <span className="note">Вікно вибору порту браузера змінити не можна, тому стан плат показано тут.</span>
      </div>

      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!canRun} onClick={() => run()}>{skipFlash ? "Вибрати порт і записати налаштування" : "Вибрати порт і прошити"}</button>
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
      {help === "boot" && (
        <div className="panel" style={{ borderColor: "var(--warn)", marginTop: 8 }}>
          <b>Введіть плату в режим прошивання кнопками</b> (так буває з новими платами із заводською прошивкою):
          <ol>
            <li>Затисніть кнопку <b>BOOT</b> (на деяких платах B, IO0 або IO9).</li>
            <li>Не відпускаючи її, коротко натисніть <b>RST</b> (або RESET, EN, R).</li>
            <li>Відпустіть BOOT. Інший спосіб: тримаючи BOOT, вставте кабель USB.</li>
            <li>Натисніть кнопку нижче і виберіть плату. Порт може називатися інакше, ніж до цього.</li>
          </ol>
          <button className="primary" disabled={!canRun} onClick={() => run(undefined, false)}>Вибрати порт ще раз і прошити</button>
        </div>
      )}
      {help === "port" && (
        <div className="panel" style={{ borderColor: "var(--warn)", marginTop: 8 }}>
          Натисніть на платі <b>RST</b> (без BOOT), зачекайте 3 секунди, потім натисніть кнопку нижче і виберіть плату ще раз.
          Прошивати знову не треба: сайт лише запише Wi-Fi і налаштування.
          <div style={{ marginTop: 8 }}>
            <button className="primary" disabled={!canConfigure} onClick={() => run(undefined, true)}>Вибрати порт і записати налаштування</button>
          </div>
        </div>
      )}
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
