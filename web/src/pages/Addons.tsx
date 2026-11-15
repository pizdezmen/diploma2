// Доповнення модуля (docs/PROTOCOL.md 3.7): вбудовані (світлодіод) і підключені (екрани).
import { useEffect, useState } from "react";
import { api, Addon, AddonState, DisplayAddon, DisplayItem, Module } from "../api";
import { metricLabel } from "../format";
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

const itemName = (src: string) => SERVICE[src] ?? metricLabel(src);

function newDisplay(m: Module, existing: Addon[]): DisplayAddon {
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

export function Addons({ m, metrics }: { m: Module; metrics: string[] }) {
  const addons = m.addons ?? [];
  const states = m.addon_state ?? [];
  const [edit, setEdit] = useState<{ index: number; draft: DisplayAddon } | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = m.caps?.includes("display");
  const applied = m.applied_config_rev === m.config_rev;

  useEffect(() => setEdit(null), [m.id]);

  // Вбудовані доповнення повідомляє модуль; стара прошивка не повідомляє, тоді світлодіод видно з caps
  const builtin: AddonState[] = states.filter((s) => s.builtin);
  if (!builtin.length && m.caps?.includes("led")) builtin.push({ id: "led", type: "led", ok: true, builtin: true, error: "" });

  async function saveAll(list: Addon[], msg: string) {
    setBusy(true);
    try {
      await api(`/modules/${m.id}`, { method: "PATCH", body: { addons: list } });
      toast(msg);
      setEdit(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  function remove(i: number) {
    const a = addons[i];
    if (!confirm(`Прибрати «${a.title || a.id}» з модуля?`)) return;
    saveAll(addons.filter((_, k) => k !== i), "Прибрано");
  }

  function toggle(i: number) {
    saveAll(addons.map((a, k) => (k === i ? { ...a, enabled: !a.enabled } : a)), "Збережено");
  }

  return (
    <>
      <h2>Доповнення</h2>
      {!supported && m.fw && (
        <div className="panel warn-panel">
          <span className="badge warn">Увага</span> Прошивка модуля {m.fw} не вміє екрани. Налаштування збережуться, але діятимуть
          після оновлення прошивки до 0.4.0 або новішої.
        </div>
      )}
      <table className="grid">
        <thead>
          <tr><th>Назва</th><th>Тип</th><th>Підключення</th><th>Що показує</th><th>Стан</th><th></th></tr>
        </thead>
        <tbody>
          {builtin.map((b) => (
            <tr key={"b-" + b.id}>
              <td>Вбудований світлодіод</td>
              <td>{TYPE_LABELS[b.type] ?? b.type}</td>
              <td>на платі{b.hw ? `, ${b.hw}` : ""}</td>
              <td className="muted">керування кнопками вгорі сторінки і з правил</td>
              <td className={m.online ? "ok" : "muted"}>{m.online ? (m.led === "on" ? "увімкнено" : m.led === "blink" ? "блимає" : "вимкнено") : "немає зв'язку з модулем"}</td>
              <td></td>
            </tr>
          ))}
          {addons.map((a, i) => (
            <tr key={a.id} className={edit?.index === i ? "selected" : ""}>
              <td>{a.title || a.id} {!a.enabled && <span className="badge">вимкнено</span>}</td>
              <td>{TYPE_LABELS[a.type] ?? a.type} <span className="muted">{a.driver.toUpperCase()} {a.height === 32 ? "128×32" : "128×64"}</span></td>
              <td className="mono">SDA {a.sda}, SCL {a.scl}, 0x{a.addr.toString(16).toUpperCase()}</td>
              <td className="wrap">{VIEW_LABELS[a.view]}: {a.items.map((x) => x.label || itemName(x.src)).join(", ") || "нічого"}</td>
              {stateCell(m, states.find((s) => s.id === a.id && !s.builtin), applied)}
              <td style={{ whiteSpace: "nowrap" }}>
                <button disabled={busy} onClick={() => setEdit({ index: i, draft: structuredClone(a) })}>Змінити</button>{" "}
                <button disabled={busy} onClick={() => toggle(i)}>{a.enabled ? "Вимкнути" : "Увімкнути"}</button>{" "}
                <button className="danger" disabled={busy} onClick={() => remove(i)}>Прибрати</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button disabled={busy || addons.length >= 4 || !!edit} onClick={() => setEdit({ index: -1, draft: newDisplay(m, addons) })}>Додати екран</button>
        <span className="note">Екран OLED 0,96″ 128×64 на I2C (SSD1306, SSD1315, SH1106). До 4 доповнень на модуль.</span>
      </div>
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
            const list = edit.index < 0 ? [...addons, d] : addons.map((a, k) => (k === edit.index ? d : a));
            saveAll(list, "Збережено, модуль отримає налаштування");
          }}
        />
      )}
    </>
  );
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
                    <select value={it.src} onChange={(e) => setItem(i, { src: e.target.value })}>
                      <optgroup label="Показники">
                        {allMetrics.map((k) => <option key={k} value={k}>{metricLabel(k)}</option>)}
                      </optgroup>
                      <optgroup label="Службові">
                        {Object.entries(SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </optgroup>
                    </select>
                  </td>
                  <td><input value={it.label} maxLength={24} placeholder={DEFAULT_LABEL[it.src] ?? it.src} onChange={(e) => setItem(i, { label: e.target.value })} style={{ width: 120 }} /></td>
                  <td>
                    {it.src.startsWith("@") || it.src === "uptime_s" ? <span className="muted">—</span> : (
                      <input value={it.unit} maxLength={8} placeholder={DEFAULT_UNIT[it.src] ?? ""} onChange={(e) => setItem(i, { unit: e.target.value })} style={{ width: 60 }} />
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
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={() => onSave(d)}>Зберегти екран</button>
        <button disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </div>
  );
}
