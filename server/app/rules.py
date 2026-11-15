"""Етап 3: правила автоматизації, тривоги й канали сповіщень.

Правило складається з:
  scope    де діє:      {"type": "all"} | {"type": "group", "group_id": 1} | {"type": "modules", "ids": ["..."]}
  trigger  коли:        {"type": "metric", "metric": "chip_temp_c", "op": ">", "value": 70, "for_s": 10}
                        {"type": "offline", "for_s": 60}          немає зв'язку довше for_s
                        {"type": "online"}                         модуль знову на зв'язку (разова подія)
                        {"type": "schedule", "mode": "daily", "time": "08:00", "days": [1, 2, 3, 4, 5, 6, 7]}
                        {"type": "schedule", "mode": "every", "every_min": 30}
  actions  що робити:   [{"type": "command", "name": "led", "params": {"mode": "blink"}, "target": null}, ...]
                        [{"type": "command", "name": "restart"}], [{"type": "interval", "interval_s": 10}]
                        target = null: модуль, на якому спрацювало правило (для розкладу: усі модулі з scope);
                        target = "<id>": інший модуль.
  recovery_actions      те саме, але після повернення в норму (лише для metric і offline).
  notify   показати тривогу в інтерфейсі й надіслати в канали сповіщень.

Тригери metric і offline мають стан: тривога триває від спрацювання до повернення в норму
(для metric умова має бути хибною for_s секунд, для offline модуль має повернутися на зв'язок).
"""
import asyncio
import json
import logging
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from . import db
from .hub import hub

log = logging.getLogger("rules")

LEVELS = ("info", "warning", "alarm")
LEVEL_RANK = {lv: i for i, lv in enumerate(LEVELS)}
OPS = {
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    "=": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
}
METRICS = {
    "rssi": ("Рівень Wi-Fi", "дБм"),
    "chip_temp_c": ("Температура чипа", "°C"),
    "uptime_s": ("Час роботи", "с"),
    "heap_free": ("Вільна пам'ять", "байт"),
}
LED_MODES = ("on", "off", "blink")


def _mqtt():
    # mqtt імпортує rules, тому імпортуємо його тут, щоб уникнути циклу
    from .mqtt import mqtt
    return mqtt


def _now() -> float:
    return time.time()


def _module_title(mid: str | None) -> str:
    if not mid:
        return ""
    m = _mqtt().modules.get(mid) or {}
    return m.get("name") or mid


def _fmt_num(v) -> str:
    if v is None:
        return "—"
    if float(v).is_integer():
        return str(int(v))
    return f"{v:.1f}"


def _fmt_dur(s: float) -> str:
    s = int(s)
    if s >= 3600:
        return f"{s // 3600} год {s % 3600 // 60} хв"
    if s >= 60:
        return f"{s // 60} хв {s % 60} с"
    return f"{s} с"


# ---------------- перевірка правил ----------------
class RuleError(ValueError):
    pass


def validate(rule: dict) -> dict:
    """Перевіряє й нормалізує правило з інтерфейсу. Повертає поля для таблиці rules."""
    name = str(rule.get("name") or "").strip()[:100]
    if not name:
        raise RuleError("Вкажіть назву правила")
    level = rule.get("level") or "warning"
    if level not in LEVELS:
        raise RuleError("Невідомий рівень")

    sc = rule.get("scope") or {"type": "all"}
    if sc.get("type") == "group":
        if not isinstance(sc.get("group_id"), int):
            raise RuleError("Оберіть групу")
        scope = {"type": "group", "group_id": sc["group_id"]}
    elif sc.get("type") == "modules":
        ids = [i for i in sc.get("ids") or [] if isinstance(i, str)]
        if not ids:
            raise RuleError("Оберіть хоча б один модуль")
        scope = {"type": "modules", "ids": ids[:500]}
    else:
        scope = {"type": "all"}

    t = rule.get("trigger") or {}
    tt = t.get("type")
    if tt == "metric":
        metric = str(t.get("metric") or "").strip()
        if not metric:
            raise RuleError("Вкажіть показник")
        if t.get("op") not in OPS:
            raise RuleError("Невідома умова")
        try:
            value = float(t.get("value"))
        except (TypeError, ValueError):
            raise RuleError("Вкажіть число для порівняння")
        trigger = {"type": "metric", "metric": metric, "op": t["op"], "value": value,
                   "for_s": _int(t.get("for_s"), 0, 0, 86400)}
    elif tt == "offline":
        trigger = {"type": "offline", "for_s": _int(t.get("for_s"), 60, 0, 86400 * 7)}
    elif tt == "online":
        trigger = {"type": "online"}
    elif tt == "schedule":
        if t.get("mode") == "every":
            trigger = {"type": "schedule", "mode": "every", "every_min": _int(t.get("every_min"), 60, 1, 10080)}
        else:
            tm = str(t.get("time") or "")
            try:
                hh, mm = (int(x) for x in tm.split(":"))
                assert 0 <= hh < 24 and 0 <= mm < 60
            except Exception:
                raise RuleError("Час має бути у вигляді ГГ:ХХ")
            days = sorted({d for d in t.get("days") or [] if isinstance(d, int) and 1 <= d <= 7})
            if not days:
                raise RuleError("Оберіть хоча б один день тижня")
            trigger = {"type": "schedule", "mode": "daily", "time": f"{hh:02d}:{mm:02d}", "days": days}
    else:
        raise RuleError("Невідомий тип умови")

    actions = [_action(a) for a in rule.get("actions") or []]
    recovery = [_action(a) for a in rule.get("recovery_actions") or []] if tt in ("metric", "offline") else []
    notify = bool(rule.get("notify", True))
    if not notify and not actions and not recovery:
        raise RuleError("Правило нічого не робить: увімкніть сповіщення або додайте дію")
    return {
        "name": name,
        "enabled": bool(rule.get("enabled", True)),
        "scope": scope,
        "trigger": trigger,
        "actions": actions,
        "recovery_actions": recovery,
        "level": level,
        "notify": notify,
        "message": str(rule.get("message") or "")[:500],
        "cooldown_s": _int(rule.get("cooldown_s"), 60, 0, 86400),
        "note": str(rule.get("note") or "")[:1000],
    }


def _int(v, default: int, lo: int, hi: int) -> int:
    if v is None or v == "":
        return default
    try:
        v = int(v)
    except (TypeError, ValueError):
        raise RuleError("Очікується ціле число")
    if not lo <= v <= hi:
        raise RuleError(f"Число має бути від {lo} до {hi}")
    return v


def _action(a: dict) -> dict:
    if not isinstance(a, dict):
        raise RuleError("Некоректна дія")
    target = a.get("target") or None
    if target is not None and not isinstance(target, str):
        raise RuleError("Некоректний модуль у дії")
    if a.get("type") == "command":
        if a.get("name") == "led":
            mode = (a.get("params") or {}).get("mode")
            if mode not in LED_MODES:
                raise RuleError("Світлодіод: оберіть увімк., вимк. або блимати")
            return {"type": "command", "name": "led", "params": {"mode": mode}, "target": target}
        if a.get("name") == "restart":
            return {"type": "command", "name": "restart", "params": {}, "target": target}
        raise RuleError("Невідома команда")
    if a.get("type") == "interval":
        iv = a.get("interval_s")
        iv = None if iv in (None, "") else _int(iv, 1, 1, 3600)
        return {"type": "interval", "interval_s": iv, "target": target}
    raise RuleError("Невідомий тип дії")


def describe_trigger(t: dict) -> str:
    tt = t.get("type")
    if tt == "metric":
        label, unit = METRICS.get(t["metric"], (t["metric"], ""))
        s = f"{label} {t['op']} {_fmt_num(t['value'])}{(' ' + unit) if unit else ''}"
        if t.get("for_s"):
            s += f" довше {_fmt_dur(t['for_s'])}"
        return s
    if tt == "offline":
        return f"Немає зв'язку довше {_fmt_dur(t.get('for_s', 0))}"
    if tt == "online":
        return "Модуль знову на зв'язку"
    if tt == "schedule":
        if t.get("mode") == "every":
            return f"Кожні {t['every_min']} хв"
        return f"О {t['time']}"
    return "?"


# ---------------- канали сповіщень ----------------
# Щоб додати власний канал, допишіть клас із type, title, fields і методом send та зареєструйте його в CHANNEL_TYPES.
class Channel:
    type = ""
    title = ""
    fields: list[dict] = []  # {"key", "label", "secret"}: що показати у формі

    def __init__(self, config: dict):
        self.config = config

    def send(self, text: str, level: str, data: dict) -> None:  # виконується в окремому потоці
        raise NotImplementedError


def _post_json(url: str, body: dict, timeout: float = 10) -> None:
    req = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False, default=str).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()


class TelegramChannel(Channel):
    type = "telegram"
    title = "Telegram"
    fields = [
        {"key": "bot_token", "label": "Токен бота (від @BotFather)", "secret": True},
        {"key": "chat_id", "label": "ID чату", "secret": False},
    ]
    ICON = {"info": "ℹ️", "warning": "⚠️", "alarm": "🚨", "ok": "✅"}

    def send(self, text: str, level: str, data: dict) -> None:
        token = self.config.get("bot_token", "")
        chat = self.config.get("chat_id", "")
        if not token or not chat:
            raise RuntimeError("Не вказано токен бота або ID чату")
        icon = self.ICON.get("ok" if data.get("kind") == "recovery" else level, "")
        _post_json(f"https://api.telegram.org/bot{token}/sendMessage", {"chat_id": chat, "text": f"{icon} {text}"})


class WebhookChannel(Channel):
    type = "webhook"
    title = "Вебхук (HTTP POST, JSON)"
    fields = [{"key": "url", "label": "Адреса", "secret": False}]

    def send(self, text: str, level: str, data: dict) -> None:
        url = self.config.get("url", "")
        if not url.startswith(("http://", "https://")):
            raise RuntimeError("Адреса має починатися з http:// або https://")
        _post_json(url, {"text": text, "level": level, **data})


CHANNEL_TYPES: dict[str, type[Channel]] = {c.type: c for c in (TelegramChannel, WebhookChannel)}


def mask_channel(r: dict) -> dict:
    cls = CHANNEL_TYPES.get(r["type"])
    cfg = dict(r["config"] or {})
    for f in (cls.fields if cls else []):
        if f.get("secret") and cfg.get(f["key"]):
            v = str(cfg[f["key"]])
            cfg[f["key"]] = "••••" + v[-4:]
    return {**r, "config": cfg}


async def send_channels(text: str, level: str, data: dict, only_id: int | None = None) -> list[dict]:
    """Надсилає повідомлення в усі увімкнені канали з відповідним рівнем. Повертає результати."""
    if only_id is not None:
        rows = await db.p().fetch("SELECT * FROM notify_channels WHERE id = $1", only_id)
    else:
        rows = await db.p().fetch("SELECT * FROM notify_channels WHERE enabled")
    out = []
    for r in rows:
        if only_id is None and LEVEL_RANK.get(level, 0) < LEVEL_RANK.get(r["min_level"], 1):
            continue
        if only_id is None and data.get("kind") == "recovery" and not (r["config"] or {}).get("send_recovery", True):
            continue
        cls = CHANNEL_TYPES.get(r["type"])
        err = ""
        if not cls:
            err = f"Невідомий тип каналу {r['type']}"
        else:
            try:
                await asyncio.to_thread(cls(r["config"] or {}).send, text, level, data)
            except Exception as e:
                err = str(e)[:300] or e.__class__.__name__
                log.warning("Канал %s: %s", r["name"], err)
        if err != r["last_error"]:
            await db.p().execute("UPDATE notify_channels SET last_error = $2 WHERE id = $1", r["id"], err)
        out.append({"id": r["id"], "name": r["name"], "error": err})
    return out


# ---------------- рушій ----------------
@dataclass
class State:
    cond_since: float | None = None   # з якого моменту умова істинна
    clear_since: float | None = None  # з якого моменту умова хибна
    value: float | None = None
    alert_id: int | None = None       # активна тривога
    active: bool = False
    last_fire: float = 0.0


class Engine:
    def __init__(self) -> None:
        self.rules: dict[int, dict] = {}
        self.by_metric: dict[str, list[dict]] = {}
        self.state: dict[tuple[int, str], State] = {}
        self.prev_online: dict[str, bool] = {}
        self.tz = ZoneInfo("Europe/Kyiv")
        self._task: asyncio.Task | None = None
        self._last_minute: str = ""
        self._bg: set[asyncio.Task] = set()

    async def start(self) -> None:
        tzname = await db.get_setting("timezone")
        try:
            self.tz = ZoneInfo(tzname or "Europe/Kyiv")
        except Exception:
            log.warning("Невідомий часовий пояс %s, використовую Europe/Kyiv", tzname)
        await self.reload()
        # Відновлюємо активні тривоги після перезапуску сервера
        for a in await db.p().fetch("SELECT * FROM alerts WHERE ended_at IS NULL AND source = 'rule'"):
            if a["rule_id"] in self.rules and a["module_id"]:
                st = self.state.setdefault((a["rule_id"], a["module_id"]), State())
                st.active, st.alert_id, st.value = True, a["id"], a["value"]
                st.last_fire = a["started_at"].timestamp()
            else:
                await self._close_alert(a["id"], "Правило змінено або видалено")
        for mid, m in _mqtt().modules.items():
            self.prev_online[mid] = bool(m.get("online"))
        self._task = asyncio.create_task(self._loop(), name="rules")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def reload(self) -> None:
        rows = await db.p().fetch("SELECT * FROM rules WHERE enabled")
        self.rules = {r["id"]: dict(r) for r in rows}
        by_metric: dict[str, list[dict]] = {}
        for r in self.rules.values():
            if r["trigger"].get("type") == "metric":
                by_metric.setdefault(r["trigger"]["metric"], []).append(r)
        self.by_metric = by_metric
        # стан правил, яких більше немає, прибираємо
        for key in [k for k in self.state if k[0] not in self.rules]:
            st = self.state.pop(key)
            if st.alert_id:
                await self._close_alert(st.alert_id, "Правило змінено або вимкнено")

    async def rule_changed(self, rule_id: int) -> None:
        """Після зміни правила скидаємо його стан: перевірка почнеться з нуля з наступних даних."""
        for key in [k for k in self.state if k[0] == rule_id]:
            st = self.state.pop(key)
            if st.alert_id:
                await self._close_alert(st.alert_id, "Правило змінено")
        await self.reload()

    @staticmethod
    def in_scope(rule: dict, m: dict) -> bool:
        sc = rule["scope"]
        if sc.get("type") == "group":
            return m.get("group_id") == sc.get("group_id")
        if sc.get("type") == "modules":
            return m.get("id") in sc.get("ids", [])
        return True

    # Викликається з mqtt для кожного виміру. Лише запам'ятовує стан; рішення приймає _tick.
    def feed(self, mid: str, ts_ms: int, values: dict) -> None:
        if not self.by_metric:
            return
        m = _mqtt().modules.get(mid)
        if not m:
            return
        t = ts_ms / 1000
        for metric, v in values.items():
            for r in self.by_metric.get(metric, ()):
                if not self.in_scope(r, m):
                    continue
                trig = r["trigger"]
                st = self.state.setdefault((r["id"], mid), State())
                st.value = v
                if OPS[trig["op"]](v, trig["value"]):
                    st.clear_since = None
                    if st.cond_since is None:
                        st.cond_since = t
                else:
                    st.cond_since = None
                    if st.clear_since is None:
                        st.clear_since = t

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(1)
            try:
                await self._tick()
            except Exception:
                log.exception("Помилка перевірки правил")

    async def _tick(self) -> None:
        now = _now()
        modules = _mqtt().modules
        # metric
        for (rid, mid), st in list(self.state.items()):
            r = self.rules.get(rid)
            if not r or r["trigger"].get("type") != "metric":
                continue
            m = modules.get(mid)
            if m is None or not self.in_scope(r, m):
                self.state.pop((rid, mid), None)
                if st.alert_id:
                    await self._close_alert(st.alert_id, "Модуль більше не підпадає під правило")
                continue
            hold = r["trigger"].get("for_s", 0)
            if not st.active and st.cond_since is not None and now - st.cond_since >= hold:
                if now - st.last_fire >= r["cooldown_s"]:
                    await self._fire(r, mid, st)
            elif st.active and st.clear_since is not None and now - st.clear_since >= hold:
                await self._recover(r, mid, st)
        # offline / online
        for r in self.rules.values():
            tt = r["trigger"].get("type")
            if tt not in ("offline", "online"):
                continue
            for mid, m in modules.items():
                if not self.in_scope(r, m):
                    continue
                if tt == "online":
                    if m.get("online") and self.prev_online.get(mid) is False:
                        await self._fire(r, mid, State(), instant=True)
                    continue
                st = self.state.setdefault((r["id"], mid), State())
                if m.get("online"):
                    if st.active:
                        await self._recover(r, mid, st)
                    continue
                since = m.get("last_seen_at") or m.get("last_status_at") or m.get("created_at")
                if since is None:
                    continue
                off_s = now - since.timestamp()
                st.value = round(off_s)
                if not st.active and off_s >= r["trigger"].get("for_s", 0) and now - st.last_fire >= r["cooldown_s"]:
                    await self._fire(r, mid, st)
        for mid, m in modules.items():
            self.prev_online[mid] = bool(m.get("online"))
        # розклад
        local = datetime.now(self.tz)
        minute = local.strftime("%Y-%m-%d %H:%M")
        new_minute = minute != self._last_minute
        self._last_minute = minute
        for r in list(self.rules.values()):
            t = r["trigger"]
            if t.get("type") != "schedule":
                continue
            if t.get("mode") == "every":
                last = (r.get("last_fired_at") or r["created_at"]).timestamp()
                if now - last >= t["every_min"] * 60:
                    await self.run_schedule(r)
            elif new_minute and local.strftime("%H:%M") == t.get("time") and local.isoweekday() in t.get("days", []):
                await self.run_schedule(r)

    # ---------- спрацювання ----------
    def _text(self, r: dict, mid: str | None, value, recovery: bool = False) -> str:
        t = r["trigger"]
        module = _module_title(mid)
        if r.get("message") and not recovery:
            label, unit = METRICS.get(t.get("metric", ""), (t.get("metric", ""), ""))
            try:
                return r["message"].format(module=module, value=_fmt_num(value), rule=r["name"],
                                           threshold=_fmt_num(t.get("value")), metric=label, unit=unit)
            except (KeyError, IndexError, ValueError):
                return r["message"]
        prefix = f"{module}: " if module else ""
        if recovery:
            if t.get("type") == "offline":
                return f"{prefix}знову на зв'язку (правило «{r['name']}»)"
            label, unit = METRICS.get(t.get("metric", ""), (t.get("metric", ""), ""))
            return f"{prefix}{label} у нормі, {_fmt_num(value)}{(' ' + unit) if unit else ''} (правило «{r['name']}»)"
        if t.get("type") == "metric":
            label, unit = METRICS.get(t["metric"], (t["metric"], ""))
            return (f"{prefix}{label} {_fmt_num(value)}{(' ' + unit) if unit else ''} {t['op']} "
                    f"{_fmt_num(t['value'])} (правило «{r['name']}»)")
        if t.get("type") == "offline":
            return f"{prefix}немає зв'язку {_fmt_dur(value or 0)} (правило «{r['name']}»)"
        if t.get("type") == "online":
            return f"{prefix}знову на зв'язку (правило «{r['name']}»)"
        return f"Виконано за розкладом: «{r['name']}»"

    async def _fire(self, r: dict, mid: str, st: State, instant: bool = False) -> None:
        now = _now()
        st.last_fire = now
        text = self._text(r, mid, st.value)
        if not instant:
            st.active = True
            st.cond_since = None
        results = await self._run_actions(r, r["actions"], [mid])
        await db.p().execute("UPDATE rules SET last_fired_at = now() WHERE id = $1", r["id"])
        r["last_fired_at"] = datetime.now(timezone.utc)
        if r["notify"]:
            if not instant:
                st.alert_id = await db.p().fetchval(
                    "INSERT INTO alerts (rule_id, module_id, level, message, value) VALUES ($1, $2, $3, $4, $5) "
                    "RETURNING id", r["id"], mid, r["level"], text, st.value)
                await self._broadcast_alert(st.alert_id)
            await self._event(mid, r, text + results, r["level"])
            self._spawn(send_channels(text, r["level"], {"kind": "alert", "rule_id": r["id"], "module_id": mid,
                                                         "value": st.value}))
        else:
            await self._event(mid, r, f"Правило «{r['name']}» спрацювало{results}", "info")

    async def _recover(self, r: dict, mid: str, st: State) -> None:
        st.active = False
        st.clear_since = None
        text = self._text(r, mid, st.value, recovery=True)
        results = await self._run_actions(r, r["recovery_actions"], [mid])
        if st.alert_id:
            await self._close_alert(st.alert_id)
            st.alert_id = None
        if r["notify"]:
            await self._event(mid, r, text + results, "info")
            self._spawn(send_channels(text, r["level"], {"kind": "recovery", "rule_id": r["id"], "module_id": mid,
                                                         "value": st.value}))
        elif results:
            await self._event(mid, r, f"Правило «{r['name']}»: норма{results}", "info")

    async def run_schedule(self, r: dict) -> str:
        """Виконує правило за розкладом (або вручну кнопкою «Виконати зараз»)."""
        await db.p().execute("UPDATE rules SET last_fired_at = now() WHERE id = $1", r["id"])
        r["last_fired_at"] = datetime.now(timezone.utc)
        if r["id"] in self.rules:
            self.rules[r["id"]]["last_fired_at"] = r["last_fired_at"]
        mods = [mid for mid, m in _mqtt().modules.items() if self.in_scope(r, m)]
        results = await self._run_actions(r, r["actions"], mods)
        text = self._text(r, None, None)
        if r["notify"]:
            await self._event(None, r, text + results, r["level"])
            self._spawn(send_channels(text, r["level"], {"kind": "schedule", "rule_id": r["id"]}))
        else:
            await self._event(None, r, text + results, "info")
        return text + results

    async def _run_actions(self, r: dict, actions: list[dict], mids: list[str]) -> str:
        if not actions:
            return ""
        mq = _mqtt()
        done, skipped = 0, 0
        for a in actions:
            targets = [a["target"]] if a.get("target") else mids
            for mid in targets:
                m = mq.modules.get(mid)
                if not m:
                    skipped += 1
                    continue
                if a["type"] == "command":
                    if not m.get("online"):
                        skipped += 1
                        continue
                    await mq.send_command(mid, a["name"], a.get("params") or {})
                    done += 1
                elif a["type"] == "interval":
                    await set_interval(mid, a.get("interval_s"))
                    done += 1
        s = f"; дій виконано: {done}"
        if skipped:
            s += f", пропущено (немає зв'язку): {skipped}"
        return s

    # ---------- допоміжне ----------
    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    async def _event(self, mid: str | None, r: dict | None, text: str, level: str) -> None:
        await db.p().execute("INSERT INTO events (module_id, level, message, rule_id) VALUES ($1, $2, $3, $4)",
                             mid, level, text[:1000], r["id"] if r else None)

    async def _close_alert(self, alert_id: int, note: str = "") -> None:
        await db.p().execute(
            "UPDATE alerts SET ended_at = now(), message = message || $2 WHERE id = $1 AND ended_at IS NULL",
            alert_id, f" [{note}]" if note else "")
        await self._broadcast_alert(alert_id)

    async def _broadcast_alert(self, alert_id: int | None) -> None:
        if alert_id is None:
            return
        row = await db.p().fetchrow(ALERT_SQL + " WHERE a.id = $1", alert_id)
        if row:
            hub.broadcast({"type": "alert", "data": dict(row)})

    # ---------- зовнішні тривоги (наприклад, тривога, яку надіслав сам модуль) ----------
    async def raise_external(self, module_id: str | None, key: str, level: str, text: str,
                             value: float | None = None, source: str = "module") -> int:
        """Відкриває тривогу (якщо такої ще немає) і надсилає в канали. Повертає id тривоги."""
        aid = await db.p().fetchval(
            "SELECT id FROM alerts WHERE source = $1 AND key = $2 AND module_id IS NOT DISTINCT FROM $3 "
            "AND ended_at IS NULL", source, key, module_id)
        if aid:
            return aid
        level = level if level in LEVELS else "alarm"
        aid = await db.p().fetchval(
            "INSERT INTO alerts (source, key, module_id, level, message, value) VALUES ($1, $2, $3, $4, $5, $6) "
            "RETURNING id", source, key, module_id, level, text, value)
        await self._broadcast_alert(aid)
        self._spawn(send_channels(text, level, {"kind": "alert", "source": source, "module_id": module_id,
                                                "value": value}))
        return aid

    async def clear_external(self, module_id: str | None, key: str, text: str | None = None,
                             source: str = "module") -> None:
        rows = await db.p().fetch(
            "UPDATE alerts SET ended_at = now() WHERE source = $1 AND key = $2 "
            "AND module_id IS NOT DISTINCT FROM $3 AND ended_at IS NULL RETURNING id, level", source, key, module_id)
        for r in rows:
            await self._broadcast_alert(r["id"])
            if text:
                self._spawn(send_channels(text, r["level"], {"kind": "recovery", "source": source,
                                                             "module_id": module_id}))


ALERT_SQL = ("SELECT a.*, r.name AS rule_name FROM alerts a LEFT JOIN rules r ON r.id = a.rule_id")


async def set_interval(mid: str, interval_s: int | None) -> None:
    mq = _mqtt()
    m = mq.modules.get(mid)
    if not m:
        return
    if m.get("interval_s") == interval_s:
        return
    from .mqtt import public_module
    await db.p().execute("UPDATE modules SET interval_s = $2 WHERE id = $1", mid, interval_s)
    m["interval_s"] = interval_s
    await mq.push_config(mid)
    hub.broadcast({"type": "module", "data": public_module(m)})


engine = Engine()
