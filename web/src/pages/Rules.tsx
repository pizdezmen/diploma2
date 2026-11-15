import { useState } from "react";
import { api, Group } from "../api";
import { fmtTime, moduleTitle } from "../format";
import { useFetch } from "../hooks";
import { useLive } from "../live";
import { Action, actionText, DAYS, LEVEL_CLS, LEVEL_TEXT, OPS, Rule, RuleLevel, RulesMeta, Scope, Trigger } from "../rulesApi";
import { toast, toastError } from "../toast";

type TriggerKind = "metric" | "offline" | "online" | "daily" | "every";

// Стан форми: усе рядками, щоб поля можна було тимчасово лишати порожніми
interface Form {
  id: number | null;
  name: string;
  enabled: boolean;
  scopeType: "all" | "group" | "modules";
  groupId: string;
  moduleIds: string[];
  kind: TriggerKind;
  metric: string;
  op: string;
  value: string;
  forS: string;
  time: string;
  days: number[];
  everyMin: string;
  level: RuleLevel;
  notify: boolean;
  message: string;
  cooldown: string;
  note: string;
  actions: Action[];
  recovery: Action[];
}

const EMPTY: Form = {
  id: null, name: "", enabled: true, scopeType: "all", groupId: "", moduleIds: [],
  kind: "metric", metric: "chip_temp_c", op: ">", value: "", forS: "10", time: "08:00", days: [1, 2, 3, 4, 5, 6, 7],
  everyMin: "60", level: "warning", notify: true, message: "", cooldown: "60", note: "", actions: [], recovery: [],
};

const KIND_TEXT: Record<TriggerKind, string> = {
  metric: "Показник поза межею",
  offline: "Немає зв'язку",
  online: "Модуль знову на зв'язку",
  daily: "Розклад: щодня о вказаний час",
  every: "Розклад: кожні N хвилин",
};

function toForm(r: Rule): Form {
  const t = r.trigger;
  const f: Form = {
    ...EMPTY, id: r.id, name: r.name, enabled: r.enabled, level: r.level, notify: r.notify, message: r.message,
    cooldown: String(r.cooldown_s), note: r.note, actions: r.actions, recovery: r.recovery_actions,
    scopeType: r.scope.type,
    groupId: r.scope.type === "group" ? String(r.scope.group_id) : "",
    moduleIds: r.scope.type === "modules" ? r.scope.ids : [],
  };
  if (t.type === "metric") Object.assign(f, { kind: "metric", metric: t.metric, op: t.op, value: String(t.value), forS: String(t.for_s) });
  else if (t.type === "offline") Object.assign(f, { kind: "offline", forS: String(t.for_s) });
  else if (t.type === "online") f.kind = "online";
  else if (t.mode === "daily") Object.assign(f, { kind: "daily", time: t.time, days: t.days });
  else Object.assign(f, { kind: "every", everyMin: String(t.every_min) });
  return f;
}

function toBody(f: Form) {
  let scope: Scope = { type: "all" };
  if (f.scopeType === "group") scope = { type: "group", group_id: Number(f.groupId) };
  if (f.scopeType === "modules") scope = { type: "modules", ids: f.moduleIds };
  let trigger: Trigger;
  if (f.kind === "metric") trigger = { type: "metric", metric: f.metric.trim(), op: f.op, value: f.value.trim() === "" ? (null as any) : Number(f.value), for_s: Number(f.forS || 0) };
  else if (f.kind === "offline") trigger = { type: "offline", for_s: Number(f.forS || 0) };
  else if (f.kind === "online") trigger = { type: "online" };
  else if (f.kind === "daily") trigger = { type: "schedule", mode: "daily", time: f.time, days: f.days };
  else trigger = { type: "schedule", mode: "every", every_min: Number(f.everyMin || 0) };
  return {
    name: f.name, enabled: f.enabled, scope, trigger, level: f.level, notify: f.notify, message: f.message,
    cooldown_s: Number(f.cooldown || 0), note: f.note, actions: f.actions,
    recovery_actions: f.kind === "metric" || f.kind === "offline" ? f.recovery : [],
  };
}

export function RulesPage() {
  const l = useLive();
  const rules = useFetch<Rule[]>("/rules", [l.alerts.size]);
  const meta = useFetch<RulesMeta>("/rules/meta");
  const groups = useFetch<{ groups: Group[] }>("/groups");
  const [form, setForm] = useState<Form | null>(null);

  const title = (id: string) => {
    const m = l.modules.get(id);
    return m ? moduleTitle(m) : id;
  };
  const groupName = (id: number) => groups.data?.groups.find((g) => g.id === id)?.name ?? `група ${id}`;
  const scopeText = (s: Scope) =>
    s.type === "all" ? "Усі модулі" : s.type === "group" ? `Група «${groupName(s.group_id)}»` : s.ids.map(title).join(", ");

  async function save() {
    if (!form) return;
    try {
      if (form.id === null) await api("/rules", { method: "POST", body: toBody(form) });
      else await api(`/rules/${form.id}`, { method: "PUT", body: toBody(form) });
      setForm(null);
      toast("Збережено");
      rules.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function toggle(r: Rule) {
    try {
      await api(`/rules/${r.id}/enabled`, { method: "POST", body: { enabled: !r.enabled } });
      rules.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function del(r: Rule) {
    if (!confirm(`Видалити правило «${r.name}»?`)) return;
    try {
      await api(`/rules/${r.id}`, { method: "DELETE" });
      rules.reload();
    } catch (e) {
      toastError(e);
    }
  }

  async function run(r: Rule) {
    try {
      const res = await api<{ message: string }>(`/rules/${r.id}/run`, { method: "POST" });
      toast(res.message);
      rules.reload();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => setForm({ ...EMPTY })}>Нове правило</button>
        <span className="info">Правило перевіряється на сервері: умова → сповіщення і дії на модулях. Розклад за часом {meta.data?.timezone ?? "Europe/Kyiv"}.</span>
      </div>

      {form && meta.data && (
        <RuleForm form={form} setForm={setForm} meta={meta.data} groups={groups.data?.groups ?? []} onSave={save} />
      )}

      <table className="grid">
        <thead>
          <tr>
            <th>Увімк.</th><th>Назва</th><th>Де діє</th><th>Умова</th><th>Сповіщення</th><th>Дії</th>
            <th>Після норми</th><th className="num">Активних</th><th>Останнє спрацювання</th><th />
          </tr>
        </thead>
        <tbody>
          {(rules.data ?? []).map((r) => (
            <tr key={r.id} className={r.enabled ? "" : "ack"}>
              <td><input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} /></td>
              <td>{r.name}</td>
              <td className="wrap">{scopeText(r.scope)}</td>
              <td>{r.summary}</td>
              <td className={r.notify ? LEVEL_CLS[r.level] : "muted"}>{r.notify ? LEVEL_TEXT[r.level] : "без сповіщення"}</td>
              <td className="wrap">{r.actions.map((a) => actionText(a, title)).join("; ") || <span className="muted">—</span>}</td>
              <td className="wrap">{r.recovery_actions.map((a) => actionText(a, title)).join("; ") || <span className="muted">—</span>}</td>
              <td className={"num " + (r.active ? LEVEL_CLS[r.level] : "")}>{r.active || ""}</td>
              <td>{fmtTime(r.last_fired_at)}</td>
              <td>
                <button className="small" onClick={() => setForm(toForm(r))}>Змінити</button>{" "}
                {r.trigger.type === "schedule" && <><button className="small" onClick={() => run(r)}>Виконати зараз</button>{" "}</>}
                <button className="small danger" onClick={() => del(r)}>Видалити</button>
              </td>
            </tr>
          ))}
          {rules.data?.length === 0 && (
            <tr><td colSpan={10} className="muted">Правил ще немає. Наприклад: «Температура чипа &gt; 70 °C довше 10 с → тривога і блимати світлодіодом».</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function RuleForm({ form: f, setForm, meta, groups, onSave }: {
  form: Form; setForm: (f: Form | null) => void; meta: RulesMeta; groups: Group[]; onSave: () => void;
}) {
  const l = useLive();
  const mods = [...l.modules.values()].sort((a, b) => moduleTitle(a).localeCompare(moduleTitle(b)));
  const set = (p: Partial<Form>) => setForm({ ...f, ...p });
  const stateful = f.kind === "metric" || f.kind === "offline";
  const unit = meta.metrics[f.metric]?.unit;

  return (
    <div className="panel" style={{ maxWidth: 820 }}>
      <div className="form-row">
        <label>Назва</label>
        <input value={f.name} onChange={(e) => set({ name: e.target.value })} style={{ flex: 1 }} autoFocus />
        <label style={{ width: "auto" }}><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> увімкнено</label>
      </div>

      <div className="form-row">
        <label>Де діє</label>
        <select value={f.scopeType} onChange={(e) => set({ scopeType: e.target.value as Form["scopeType"] })}>
          <option value="all">Усі модулі</option>
          <option value="group">Група</option>
          <option value="modules">Вибрані модулі</option>
        </select>
        {f.scopeType === "group" && (
          <select value={f.groupId} onChange={(e) => set({ groupId: e.target.value })}>
            <option value="">Оберіть групу…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
      </div>
      {f.scopeType === "modules" && (
        <div className="form-row">
          <label />
          <div className="checks">
            {mods.map((m) => (
              <label key={m.id}>
                <input type="checkbox" checked={f.moduleIds.includes(m.id)}
                  onChange={(e) => set({ moduleIds: e.target.checked ? [...f.moduleIds, m.id] : f.moduleIds.filter((x) => x !== m.id) })} />{" "}
                {moduleTitle(m)}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="form-row">
        <label>Коли спрацьовує</label>
        <select value={f.kind} onChange={(e) => set({ kind: e.target.value as TriggerKind })}>
          {(Object.keys(KIND_TEXT) as TriggerKind[]).map((k) => <option key={k} value={k}>{KIND_TEXT[k]}</option>)}
        </select>
      </div>
      {f.kind === "metric" && (
        <div className="form-row">
          <label />
          <select value={meta.metrics[f.metric] ? f.metric : ""} onChange={(e) => set({ metric: e.target.value })}>
            {Object.entries(meta.metrics).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={f.op} onChange={(e) => set({ op: e.target.value })}>
            {OPS.map((o) => <option key={o}>{o}</option>)}
          </select>
          <input type="number" value={f.value} onChange={(e) => set({ value: e.target.value })} style={{ width: 90 }} />
          {unit && <span className="note">{unit}</span>}
          <span className="note">довше</span>
          <input type="number" min={0} value={f.forS} onChange={(e) => set({ forS: e.target.value })} style={{ width: 70 }} />
          <span className="note">с</span>
        </div>
      )}
      {f.kind === "offline" && (
        <div className="form-row">
          <label />
          <span className="note">довше</span>
          <input type="number" min={0} value={f.forS} onChange={(e) => set({ forS: e.target.value })} style={{ width: 80 }} />
          <span className="note">с</span>
        </div>
      )}
      {f.kind === "daily" && (
        <div className="form-row">
          <label />
          <input type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} />
          <div className="checks">
            {DAYS.map((d, i) => (
              <label key={d}>
                <input type="checkbox" checked={f.days.includes(i + 1)}
                  onChange={(e) => set({ days: e.target.checked ? [...f.days, i + 1] : f.days.filter((x) => x !== i + 1) })} /> {d}
              </label>
            ))}
          </div>
        </div>
      )}
      {f.kind === "every" && (
        <div className="form-row">
          <label />
          <span className="note">кожні</span>
          <input type="number" min={1} value={f.everyMin} onChange={(e) => set({ everyMin: e.target.value })} style={{ width: 80 }} />
          <span className="note">хв</span>
        </div>
      )}

      <div className="form-row">
        <label>Сповіщення</label>
        <label style={{ width: "auto" }}><input type="checkbox" checked={f.notify} onChange={(e) => set({ notify: e.target.checked })} /> показати й надіслати в канали</label>
        <select value={f.level} disabled={!f.notify} onChange={(e) => set({ level: e.target.value as RuleLevel })}>
          {meta.levels.map((lv) => <option key={lv} value={lv}>{LEVEL_TEXT[lv]}</option>)}
        </select>
      </div>
      {f.notify && (
        <div className="form-row">
          <label>Власний текст</label>
          <input value={f.message} onChange={(e) => set({ message: e.target.value })} style={{ flex: 1 }}
            placeholder="порожньо = складається сам; можна {module}, {value}, {unit}, {threshold}, {rule}" />
        </div>
      )}

      <ActionList title="Дії" list={f.actions} onChange={(a) => set({ actions: a })} schedule={!stateful && f.kind !== "online"} />
      {stateful && (
        <ActionList title="Після повернення в норму" list={f.recovery} onChange={(a) => set({ recovery: a })} schedule={false} />
      )}

      {f.kind !== "daily" && f.kind !== "every" && (
        <div className="form-row">
          <label>Не частіше ніж раз на</label>
          <input type="number" min={0} value={f.cooldown} onChange={(e) => set({ cooldown: e.target.value })} style={{ width: 80 }} />
          <span className="note">с, для кожного модуля окремо</span>
        </div>
      )}
      <div className="form-row">
        <label>Примітка</label>
        <input value={f.note} onChange={(e) => set({ note: e.target.value })} style={{ flex: 1 }} />
      </div>
      <div className="toolbar">
        <button className="primary" disabled={!f.name.trim()} onClick={onSave}>Зберегти</button>
        <button onClick={() => setForm(null)}>Скасувати</button>
      </div>
    </div>
  );
}

type ActKind = "led:on" | "led:off" | "led:blink" | "restart" | "interval" | "screen";
const ACT_TEXT: Record<ActKind, string> = {
  "led:on": "Світлодіод увімк.",
  "led:off": "Світлодіод вимк.",
  "led:blink": "Світлодіод блимати",
  restart: "Перезапуск",
  interval: "Змінити інтервал надсилання",
  screen: "Вивести на екран",
};

function actKind(a: Action): ActKind {
  if (a.type === "interval") return "interval";
  if (a.type === "screen") return "screen";
  if (a.name === "restart") return "restart";
  return `led:${a.params.mode}` as ActKind;
}

function makeAction(k: ActKind, target: string | null, interval: number | null = null): Action {
  if (k === "interval") return { type: "interval", interval_s: interval, target };
  if (k === "screen") return { type: "screen", slot: 1, text: "{module}: {value}", duration_s: 0, target };
  if (k === "restart") return { type: "command", name: "restart", params: {}, target };
  return { type: "command", name: "led", params: { mode: k.slice(4) as "on" | "off" | "blink" }, target };
}

function ActionList({ title, list, onChange, schedule }: {
  title: string; list: Action[]; onChange: (a: Action[]) => void; schedule: boolean;
}) {
  const l = useLive();
  const mods = [...l.modules.values()].sort((a, b) => moduleTitle(a).localeCompare(moduleTitle(b)));
  const upd = (i: number, a: Action) => onChange(list.map((x, j) => (j === i ? a : x)));
  return (
    <>
      {list.map((a, i) => {
        const k = actKind(a);
        return (
          <div className="form-row" key={i}>
            <label>{i === 0 ? title : ""}</label>
            <select value={k} onChange={(e) => upd(i, makeAction(e.target.value as ActKind, a.target, 10))}>
              {(Object.keys(ACT_TEXT) as ActKind[]).map((x) => <option key={x} value={x}>{ACT_TEXT[x]}</option>)}
            </select>
            {a.type === "interval" && (
              <>
                <input type="number" min={1} max={3600} value={a.interval_s ?? ""} placeholder="як у групи"
                  onChange={(e) => upd(i, { ...a, interval_s: e.target.value ? Number(e.target.value) : null })} style={{ width: 90 }} />
                <span className="note">с</span>
              </>
            )}
            {a.type === "screen" && (
              <>
                <select value={a.slot} onChange={(e) => upd(i, { ...a, slot: Number(e.target.value) })} title="Місце на екрані: пункт «Повідомлення правила» з тим самим номером">
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>місце {n}</option>)}
                </select>
                <input value={a.text} maxLength={60} onChange={(e) => upd(i, { ...a, text: e.target.value })} style={{ width: 220 }}
                  placeholder="порожньо = прибрати повідомлення" title="Можна {module}, {value}, {unit}, {threshold}, {rule}" />
                <input type="number" min={0} max={86400} value={a.duration_s || ""} placeholder="до наступного"
                  onChange={(e) => upd(i, { ...a, duration_s: Number(e.target.value || 0) })} style={{ width: 110 }} title="Скільки секунд показувати; порожньо = поки не замінить інше повідомлення" />
                <span className="note">с</span>
              </>
            )}
            <select value={a.target ?? ""} onChange={(e) => upd(i, { ...a, target: e.target.value || null })}>
              <option value="">{schedule ? "усі модулі правила" : "той модуль, де спрацювало"}</option>
              {mods.map((m) => <option key={m.id} value={m.id}>{moduleTitle(m)}</option>)}
            </select>
            <button className="small danger" onClick={() => onChange(list.filter((_, j) => j !== i))}>Прибрати</button>
          </div>
        );
      })}
      <div className="form-row">
        <label>{list.length ? "" : title}</label>
        <button className="small" onClick={() => onChange([...list, makeAction("led:blink", null)])}>Додати дію</button>
      </div>
    </>
  );
}
