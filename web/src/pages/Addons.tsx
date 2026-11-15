// Доповнення модуля (docs/PROTOCOL.md 3.7): вбудовані (світлодіод) і підключені (екрани).
import { useEffect, useState } from "react";
import { api, Addon, AddonState, DisplayAddon, DisplayItem, LedAddon, Module } from "../api";
import { metricLabel, moduleTitle } from "../format";
import { useLive } from "../live";
import { toast, toastError } from "../toast";

const TYPE_LABELS: Record<string, string> = { display: "Екран", led: "Світлодіод" };
const VIEW_LABELS: Record<DisplayAddon["view"], string> = { big: "один великим", list: "списком", cycle: "по черзі" };

// Службові пункти екрана; підписи за замовчуванням такі самі, як на сервері (modcfg.DISPLAY_DEFAULTS)
const SERVICE: Record<string, string> = {
  "@name": "Назва модуля",
  "@link": "Зв'язок (Wi-Fi і сервер)",
  "@ip": "IP-адреса",
  "@ssid": "Мережа Wi-Fi",
  "@fw": "Версія прошивки",
  "@id": "Ідентифікатор модуля",
};
const DEFAULT_LABEL: Record<string, string> = {
  "@name": "Модуль", "@id": "ID", "@fw": "Прошивка", "@ip": "IP", "@ssid": "Мережа", "@link": "Зв'язок",
  rssi: "Wi-Fi", chip_temp_c: "Темп. чипа", uptime_s: "Працює", heap_free: "Пам'ять", heap_min_free: "Мін. пам'ять",
};
const DEFAULT_UNIT: Record<string, string> = { rssi: "дБм", chip_temp_c: "°C", heap_free: "Б", heap_min_free: "Б" };
const METRIC_ORDER = ["chip_temp_c", "rssi", "uptime_s", "heap_free", "heap_min_free"];

// Рекомендовані виводи: S3 DevKitC-1 — GPIO8/9, C3 SuperMini — GPIO5/6; кнопка BOOT для пробудження
function defaultPins(chip: string | null) {
  return chip === "esp32c3" ? { sda: 5, scl: 6, button: 9 } : { sda: 8, scl: 9, button: 0 };
}

// Дані, яких немає на самому модулі: сталий текст, показник іншого модуля, повідомлення правила
const DATA: Record<string, string> = {
  "@text": "Текст",
  "@remote": "Показник іншого модуля",
  "@msg": "Повідомлення правила",
};

function itemName(it: DisplayItem, title: (id: string) => string) {
  if (it.src === "@text") return `«${it.text ?? ""}»`;
  if (it.src === "@remote") return `${metricLabel(it.metric ?? "")} (${title(it.module ?? "")})`;
  if (it.src === "@msg") return `повідомлення ${it.slot ?? 1}`;
  return SERVICE[it.src] ?? metricLabel(it.src);
}

function newDisplay(m: Module, existing: DisplayAddon[]): DisplayAddon {
  let n = 1;
  while (existing.some((a) => a.id === `oled${n}`)) n++;
  return {
    type: "display", id: `oled${n}`, title: `Екран ${n}`, enabled: true, driver: "ssd1306",
    ...defaultPins(m.chip), addr: n === 2 ? 0x3d : 0x3c, height: 64, flip: false, brightness: 100, off_after_s: 0,
    view: "list", cycle_s: 5,
    items: [{ src: "@name", label: "", unit: "" }, { src: "chip_temp_c", label: "", unit: "" }, { src: "rssi", label: "", unit: "" }, { src: "@link", label: "", unit: "" }],
  };
}

function stateCell(m: Module, st: AddonState | undefined, applied: boolean) {
  if (!m.online) return <td className="muted">немає зв'язку з модулем</td>;
  if (!applied) return <td className="warn">очікує застосування</td>;
  if (!st) return <td className="muted">—</td>;
  return st.ok ? <td className="ok">працює</td> : <td className="warn wrap">{st.error || "не працює"}</td>;
}

const LED_STATE: Record<string, string> = { on: "світиться", blink: "блимає", breathe: "дихає", rainbow: "веселка", off: "вимкнено" };
const LED_MODES: [string, string][] = [["on", "Увімкнути"], ["blink", "Блимати"], ["breathe", "Дихання"], ["rainbow", "Веселка"], ["off", "Вимкнути"]];

export function Addons({ m, metrics, onCommand }: { m: Module; metrics: string[]; onCommand: (name: string, params?: any) => void }) {
  const all = m.addons ?? [];
  const ledCfg = all.find((a): a is LedAddon => a.type === "led");
  const displays = all.filter((a): a is DisplayAddon => a.type === "display");
  const states = m.addon_state ?? [];
  const [edit, setEdit] = useState<{ index: number; draft: DisplayAddon } | null>(null);
  const [ledEdit, setLedEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const l = useLive();
  const title = (id: string) => { const x = l.modules.get(id); return x ? moduleTitle(x) : id; };
  const supported = m.caps?.includes("display");
  const applied = m.applied_config_rev === m.config_rev;

  useEffect(() => {
    setEdit(null);
    setLedEdit(false);
  }, [m.id]);

  // Світлодіод повідомляє модуль (з 0.4.0); стара прошивка не повідомляє, тоді його видно з caps
  const ledState = states.find((s) => s.builtin && s.type === "led");
  const hasLed = !!ledState || m.caps?.includes("led");

  async function saveAll(list: Addon[], msg: string) {
    setBusy(true);
    try {
      await api(`/modules/${m.id}`, { method: "PATCH", body: { addons: list } });
      toast(msg);
      setEdit(null);
      setLedEdit(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  // led: undefined — лишити як є, null — прибрати (прошивка візьме своє за замовчуванням)
  const withLed = (list: DisplayAddon[], led: LedAddon | null | undefined = ledCfg): Addon[] => {
    const cur = led === undefined ? ledCfg : led;
    return cur ? [cur, ...list] : list;
  };

  function remove(i: number) {
    const a = displays[i];
    if (!confirm(`Прибрати «${a.title || a.id}» з модуля?`)) return;
    saveAll(withLed(displays.filter((_, k) => k !== i)), "Прибрано");
  }

  function toggle(i: number) {
    saveAll(withLed(displays.map((a, k) => (k === i ? { ...a, enabled: !a.enabled } : a))), "Збережено");
  }

  return (
    <>
      <h2>Доповнення</h2>
      {!supported && m.fw && (
        <div className="panel warn-panel">
          <span className="badge warn">Увага</span> Прошивка модуля {m.fw} не вміє екрани і налаштування світлодіода. Налаштування
          збережуться, але діятимуть після оновлення прошивки до 0.4.0 або новішої.
        </div>
      )}
      <table className="grid">
        <thead>
          <tr><th>Назва</th><th>Тип</th><th>Підключення</th><th>Що показує</th><th>Стан</th><th></th></tr>
        </thead>
        <tbody>
          {hasLed && (
            <tr className={ledEdit ? "selected" : ""}>
              <td>Вбудований світлодіод</td>
              <td>{TYPE_LABELS.led}</td>
              <td>на платі{ledState?.hw ? `, ${ledState.hw}` : ""}{ledCfg && !applied ? <span className="muted"> (змінюється)</span> : null}</td>
              <td>
                <span className="seg">
                  {LED_MODES.filter(([k]) => (k !== "breathe" && k !== "rainbow") || m.caps?.includes("display")).map(([k, t]) => (
                    <button key={k} className={m.led === k ? "on" : ""} disabled={!m.online} onClick={() => onCommand("led", { mode: k })}>{t}</button>
                  ))}
                </span>
              </td>
              {!m.online ? <td className="muted">немає зв'язку з модулем</td>
                : ledState && !ledState.ok ? <td className="warn wrap">{ledState.error || "не працює"}</td>
                : <td className="ok">{LED_STATE[m.led ?? "off"] ?? m.led}{m.led === "off" && ledCfg?.show_status ? ", показує стан" : ""}</td>}
              <td style={{ whiteSpace: "nowrap" }}>
                <button disabled={busy || !!edit} onClick={() => setLedEdit(true)}>Налаштувати</button>
              </td>
            </tr>
          )}
          {displays.map((a, i) => (
            <tr key={a.id} className={edit?.index === i ? "selected" : ""}>
              <td>{a.title || a.id} {!a.enabled && <span className="badge">вимкнено</span>}</td>
              <td>{TYPE_LABELS[a.type] ?? a.type} <span className="muted">{a.driver.toUpperCase()} {a.height === 32 ? "128×32" : "128×64"}</span></td>
              <td className="mono">SDA {a.sda}, SCL {a.scl}, 0x{a.addr.toString(16).toUpperCase()}</td>
              <td className="wrap">{VIEW_LABELS[a.view]}: {a.items.map((x) => x.label || itemName(x, title)).join(", ") || "нічого"}</td>
              {stateCell(m, states.find((s) => s.id === a.id && !s.builtin), applied)}
              <td style={{ whiteSpace: "nowrap" }}>
                <button disabled={busy || ledEdit} onClick={() => setEdit({ index: i, draft: structuredClone(a) })}>Змінити</button>{" "}
                <button disabled={busy} onClick={() => toggle(i)}>{a.enabled ? "Вимкнути" : "Увімкнути"}</button>{" "}
                <button className="danger" disabled={busy} onClick={() => remove(i)}>Прибрати</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button disabled={busy || displays.length >= 4 || !!edit || ledEdit} onClick={() => setEdit({ index: -1, draft: newDisplay(m, displays) })}>Додати екран</button>
        <span className="note">Екран OLED 0,96″ 128×64 на I2C (SSD1306, SSD1315, SH1106). До 4 екранів на модуль. Світлодіодом керують і правила.</span>
      </div>
      {ledEdit && (
        <LedEditor
          m={m}
          cfg={ledCfg}
          state={ledState}
          busy={busy}
          onCancel={() => setLedEdit(false)}
          onSave={(led) => saveAll(withLed(displays, led), led ? "Збережено, модуль отримає налаштування" : "Повернено типові налаштування світлодіода")}
        />
      )}
      {edit && (
        <DisplayEditor
          key={edit.index}
          m={m}
          metrics={metrics}
          draft={edit.draft}
          isNew={edit.index < 0}
          busy={busy}
          onCancel={() => setEdit(null)}
          onSave={(d) => {
            const list = edit.index < 0 ? [...displays, d] : displays.map((a, k) => (k === edit.index ? d : a));
            saveAll(withLed(list), "Збережено, модуль отримає налаштування");
          }}
        />
      )}
    </>
  );
}

// Підключення вбудованого світлодіода; «За замовчуванням» прибирає налаштування, і прошивка бере своє
function LedEditor({ m, cfg, state, busy, onCancel, onSave }: {
  m: Module; cfg: LedAddon | undefined; state: AddonState | undefined; busy: boolean;
  onCancel: () => void; onSave: (led: LedAddon | null) => void;
}) {
  const def = { driver: "ws2812" as const, gpio: m.chip === "esp32c3" ? 8 : 48, active_low: false };
  const hw = cfg ?? (state?.driver ? { driver: state.driver, gpio: state.gpio ?? def.gpio, active_low: !!state.active_low } : def);
  const [driver, setDriver] = useState<LedAddon["driver"]>(hw.driver);
  const [gpio, setGpio] = useState(String(hw.gpio));
  const [low, setLow] = useState(hw.active_low);
  const [color, setColor] = useState(cfg?.color ?? "#00ff00");
  const [brightness, setBrightness] = useState(cfg?.brightness ?? 20);
  const [period, setPeriod] = useState(String(cfg?.period_ms ?? 500));
  const [status, setStatus] = useState(cfg?.show_status ?? false);
  const rgb = driver === "ws2812";
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="chart-title">Вбудований світлодіод</div>
      <div className="layout-2">
        <div>
          {rgb && (
            <div className="form-row">
              <label>Колір</label>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              <span className="mono">{color}</span>
              <span className="note">для «Увімкнути», «Блимати» і «Дихання»</span>
            </div>
          )}
          <div className="form-row">
            <label>Яскравість, %</label>
            <input type="range" min={1} max={100} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} style={{ flex: 1 }} disabled={!rgb} />
            <span style={{ width: 40 }}>{rgb ? brightness : "—"}</span>
          </div>
          <div className="form-row">
            <label>Швидкість ефектів, мс</label>
            <input type="number" min={100} max={10000} step={100} value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 90 }} />
            <span className="note">повний цикл блимання, дихання чи веселки</span>
          </div>
          <div className="form-row">
            <label>Показувати стан</label>
            <label style={{ width: "auto" }}><input type="checkbox" checked={status} onChange={(e) => setStatus(e.target.checked)} /> коли світлодіод вимкнено</label>
          </div>
          <div className="note" style={{ margin: "-2px 0 6px 158px" }}>
            Зелений — усе гаразд, жовтий — немає Wi-Fi чи сервера, червоний — показник поза нормою. «Увімкнути», «Блимати» та інші режими
            з кнопок чи правил мають перевагу; «Вимкнути» повертає показ стану.
          </div>
        </div>
        <div>
          <div className="form-row">
            <label>Тип</label>
            <select value={driver} onChange={(e) => setDriver(e.target.value as LedAddon["driver"])}>
              <option value="ws2812">кольоровий RGB (WS2812)</option>
              <option value="gpio">звичайний одноколірний</option>
            </select>
          </div>
          <div className="form-row">
            <label>Вивід GPIO</label>
            <input type="number" min={0} max={48} value={gpio} onChange={(e) => setGpio(e.target.value)} style={{ width: 70 }} />
            {!rgb && (
              <label style={{ width: "auto" }}><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> інверсний</label>
            )}
          </div>
          <div className="note">
            Зазвичай: ESP32-S3 — RGB на GPIO48 (на деяких платах GPIO38), ESP32-C3 — RGB на GPIO8. Одноколірний світлодіод уміє лише
            світитися й блимати.
          </div>
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || gpio === "" || period === ""} onClick={() => onSave({
          type: "led", id: "led", title: "", driver, gpio: Number(gpio), active_low: !rgb && low,
          color, brightness, period_ms: Number(period), show_status: status,
        })}>Зберегти</button>
        <button disabled={busy || !cfg} onClick={() => onSave(null)} title="Прибрати налаштування з сайту: прошивка візьме все за замовчуванням">За замовчуванням</button>
        <button disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </div>
  );
}

// Підказка в полі підпису: що буде, якщо його не заповнити
function labelHint(it: DisplayItem) {
  if (it.src === "@text" || it.src === "@msg") return "без підпису";
  if (it.src === "@remote") return DEFAULT_LABEL[it.metric ?? ""] ?? it.metric ?? "";
  return DEFAULT_LABEL[it.src] ?? it.src;
}

function DisplayEditor({ m, metrics, draft, isNew, busy, onCancel, onSave }: {
  m: Module; metrics: string[]; draft: DisplayAddon; isNew: boolean; busy: boolean;
  onCancel: () => void; onSave: (d: DisplayAddon) => void;
}) {
  const [d, setD] = useState<DisplayAddon>(draft);
  const set = (p: Partial<DisplayAddon>) => setD((x) => ({ ...x, ...p }));
  const setItem = (i: number, p: Partial<DisplayItem>) => set({ items: d.items.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  const move = (i: number, dir: -1 | 1) => {
    const items = [...d.items];
    [items[i], items[i + dir]] = [items[i + dir], items[i]];
    set({ items });
  };
  const num = (v: string) => (v === "" ? 0 : Number(v));

  const allMetrics = [...new Set([...METRIC_ORDER, ...metrics, ...Object.keys(m.last_values ?? {})])].sort((a, b) => {
    const ia = METRIC_ORDER.indexOf(a), ib = METRIC_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const l = useLive();
  const others = [...l.modules.values()].filter((x) => x.id !== m.id).sort((a, b) => moduleTitle(a).localeCompare(moduleTitle(b)));
  const metricsOf = (id: string | null | undefined) => {
    const x = id ? l.modules.get(id) : undefined;
    return [...new Set([...METRIC_ORDER, ...Object.keys(x?.last_values ?? {})])];
  };
  const pickSrc = (i: number, src: string) => {
    if (src === "@remote") {
      const mod = d.items[i].module ?? others[0]?.id ?? null;
      setItem(i, { src, module: mod, metric: d.items[i].metric ?? "chip_temp_c" });
    } else setItem(i, { src, slot: d.items[i].slot ?? 1 });
  };
  const supportsData = m.caps?.includes("screen_data");
  const usesData = d.items.some((x) => x.src in DATA);
  const pins = defaultPins(m.chip);
  const perPage = d.height === 64 ? 6 : 3;

  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="chart-title">{isNew ? "Новий екран" : `Екран «${draft.title || draft.id}»`}</div>
      <div className="layout-2">
        <div>
          <div className="form-row"><label>Назва</label><input value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} style={{ flex: 1 }} /></div>
          <div className="form-row">
            <label>Контролер</label>
            <select value={d.driver} onChange={(e) => set({ driver: e.target.value as DisplayAddon["driver"] })}>
              <option value="ssd1306">SSD1306</option>
              <option value="ssd1315">SSD1315</option>
              <option value="sh1106">SH1106 (зазвичай 1,3″)</option>
            </select>
            <select value={d.height} onChange={(e) => set({ height: Number(e.target.value) as 64 | 32 })}>
              <option value={64}>128×64</option>
              <option value={32}>128×32</option>
            </select>
          </div>
          <div className="form-row">
            <label>Виводи GPIO</label>
            SDA <input type="number" min={0} max={48} value={d.sda} onChange={(e) => set({ sda: num(e.target.value) })} style={{ width: 60 }} />
            SCL <input type="number" min={0} max={48} value={d.scl} onChange={(e) => set({ scl: num(e.target.value) })} style={{ width: 60 }} />
          </div>
          <div className="note" style={{ margin: "-2px 0 6px 158px" }}>
            Для {m.chip === "esp32c3" ? "ESP32-C3" : "ESP32-S3"} рекомендовано SDA {pins.sda}, SCL {pins.scl}. Живлення екрана від 3V3, GND до GND.
          </div>
          <div className="form-row">
            <label>Адреса I2C</label>
            <select value={d.addr} onChange={(e) => set({ addr: Number(e.target.value) })}>
              <option value={0x3c}>0x3C (зазвичай)</option>
              <option value={0x3d}>0x3D</option>
            </select>
            <label style={{ width: "auto" }}><input type="checkbox" checked={d.flip} onChange={(e) => set({ flip: e.target.checked })} /> Перевернути на 180°</label>
          </div>
          <div className="form-row">
            <label>Яскравість, %</label>
            <input type="range" min={1} max={100} value={d.brightness} onChange={(e) => set({ brightness: num(e.target.value) })} style={{ flex: 1 }} />
            <span style={{ width: 40 }}>{d.brightness}</span>
          </div>
          <div className="form-row">
            <label>Гасити через, с</label>
            <input type="number" min={0} max={86400} value={d.off_after_s} onChange={(e) => set({ off_after_s: num(e.target.value) })} style={{ width: 90 }} />
            <span className="note">{d.off_after_s ? "після ввімкнення або натискання кнопки" : "0 = світиться завжди"}</span>
          </div>
          <div className="form-row">
            <label>Кнопка</label>
            <select value={d.button} onChange={(e) => set({ button: Number(e.target.value) })}>
              <option value={-1}>немає</option>
              <option value={pins.button}>BOOT на платі (GPIO{pins.button})</option>
              {d.button >= 0 && d.button !== pins.button && <option value={d.button}>GPIO{d.button}</option>}
            </select>
            <span className="note">будить екран і гортає сторінки</span>
          </div>
          <div className="form-row">
            <label>Вид</label>
            <span className="seg">
              {(["big", "list", "cycle"] as const).map((v) => (
                <button key={v} className={d.view === v ? "on" : ""} onClick={() => set({ view: v })}>{VIEW_LABELS[v]}</button>
              ))}
            </span>
          </div>
          {d.view !== "big" && (
            <div className="form-row">
              <label>{d.view === "cycle" ? "Зміна кожні, с" : "Зміна сторінки, с"}</label>
              <input type="number" min={1} max={3600} value={d.cycle_s} onChange={(e) => set({ cycle_s: num(e.target.value) })} style={{ width: 90 }} />
              <span className="note">{d.view === "list" ? `на сторінці ${perPage} рядків; якщо пунктів більше, сторінки змінюються` : "кожен пункт великим по черзі"}</span>
            </div>
          )}
          {d.view === "big" && d.items.length > 1 && <div className="note warn-text">Вид «один великим» показує лише перший пункт.</div>}
        </div>
        <div>
          <table className="grid">
            <thead><tr><th>Що показувати</th><th>Підпис на екрані</th><th>Одиниці</th><th></th></tr></thead>
            <tbody>
              {d.items.map((it, i) => (
                <tr key={i}>
                  <td>
                    <select value={it.src} onChange={(e) => pickSrc(i, e.target.value)}>
                      <optgroup label="Показники">
                        {allMetrics.map((k) => <option key={k} value={k}>{metricLabel(k)}</option>)}
                      </optgroup>
                      <optgroup label="Службові">
                        {Object.entries(SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </optgroup>
                      <optgroup label="Інше">
                        {Object.entries(DATA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </optgroup>
                    </select>
                    {it.src === "@text" && (
                      <div><input value={it.text ?? ""} maxLength={60} placeholder="текст на екрані" onChange={(e) => setItem(i, { text: e.target.value })} style={{ width: 200, marginTop: 4 }} /></div>
                    )}
                    {it.src === "@remote" && (
                      <div style={{ marginTop: 4 }}>
                        <select value={it.module ?? ""} onChange={(e) => setItem(i, { module: e.target.value })}>
                          {!it.module && <option value="">оберіть модуль</option>}
                          {others.map((x) => <option key={x.id} value={x.id}>{moduleTitle(x)}</option>)}
                        </select>{" "}
                        <select value={it.metric ?? ""} onChange={(e) => setItem(i, { metric: e.target.value })}>
                          {metricsOf(it.module).map((k) => <option key={k} value={k}>{metricLabel(k)}</option>)}
                        </select>
                      </div>
                    )}
                    {it.src === "@msg" && (
                      <div style={{ marginTop: 4 }}>
                        місце{" "}
                        <select value={it.slot ?? 1} onChange={(e) => setItem(i, { slot: Number(e.target.value) })}>
                          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <span className="note"> текст задає дія правила «Вивести на екран»</span>
                      </div>
                    )}
                  </td>
                  <td><input value={it.label} maxLength={24} placeholder={labelHint(it)} onChange={(e) => setItem(i, { label: e.target.value })} style={{ width: 120 }} /></td>
                  <td>
                    {(it.src.startsWith("@") && it.src !== "@remote") || it.src === "uptime_s" || (it.src === "@remote" && it.metric === "uptime_s") ? <span className="muted">—</span> : (
                      <input value={it.unit} maxLength={8} placeholder={DEFAULT_UNIT[it.src === "@remote" ? it.metric ?? "" : it.src] ?? ""} onChange={(e) => setItem(i, { unit: e.target.value })} style={{ width: 60 }} />
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button disabled={i === 0} onClick={() => move(i, -1)} title="Вище">↑</button>
                    <button disabled={i === d.items.length - 1} onClick={() => move(i, 1)} title="Нижче">↓</button>
                    <button className="danger" onClick={() => set({ items: d.items.filter((_, k) => k !== i) })} title="Прибрати">✕</button>
                  </td>
                </tr>
              ))}
              {d.items.length === 0 && <tr><td colSpan={4} className="muted">Нічого не вибрано: екран буде порожнім</td></tr>}
            </tbody>
          </table>
          <div className="toolbar" style={{ marginTop: 6 }}>
            <button disabled={d.items.length >= 12} onClick={() => set({ items: [...d.items, { src: "chip_temp_c", label: "", unit: "" }] })}>Додати пункт</button>
            <span className="note">Порожній підпис: короткий підпис за замовчуванням. У рядку вміщається 21 символ.</span>
          </div>
          {usesData && !supportsData && (
            <div className="note warn-text">Текст, показники інших модулів і повідомлення правил модуль покаже після оновлення прошивки до 0.5.0.</div>
          )}
          {usesData && (
            <div className="note">Показник іншого модуля і повідомлення надсилає сервер; без зв'язку з ним на екрані «—».</div>
          )}
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={() => onSave(d)}>Зберегти екран</button>
        <button disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </div>
  );
}
