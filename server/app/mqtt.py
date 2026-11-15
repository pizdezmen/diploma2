"""Зв'язок із брокером: прийом статусів, телеметрії й відповідей, надсилання команд і конфігурації,
керування обліковими записами модулів (Mosquitto dynamic security)."""
import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone

import aiomqtt

from . import db, modcfg
from .config import settings
from .hub import hub
from .rules import engine as rules_engine

log = logging.getLogger("mqtt")

ID_RE = re.compile(r"^[0-9a-f]{12}$")
METRIC_RE = re.compile(r"^[a-z0-9_]{1,32}$")
DYNSEC_TOPIC = "$CONTROL/dynamic-security/v1"
TERMINAL = {"ok", "error", "timeout"}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class MqttService:
    def __init__(self) -> None:
        self.client: aiomqtt.Client | None = None
        self.connected = asyncio.Event()
        self.modules: dict[str, dict] = {}  # кеш стану модулів
        self.rows: list[tuple] = []  # буфер рядків телеметрії
        self.dirty_latest: set[str] = set()
        self.pending_dynsec: dict[str, asyncio.Future] = {}
        self.stats = {"messages": 0, "rows": 0, "dropped": 0}
        self._tasks: list[asyncio.Task] = []

    # ---------- запуск ----------
    async def start(self) -> None:
        rows = await db.p().fetch("SELECT * FROM modules")
        for r in rows:
            self.modules[r["id"]] = dict(r)
        self._tasks = [
            asyncio.create_task(self._run(), name="mqtt"),
            asyncio.create_task(self._flusher(), name="flusher"),
            asyncio.create_task(self._latest_pusher(), name="latest"),
            asyncio.create_task(self._command_watchdog(), name="cmd-watchdog"),
            asyncio.create_task(self._silence_watchdog(), name="silence-watchdog"),
        ]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await self._flush()

    async def _run(self) -> None:
        while True:
            try:
                async with aiomqtt.Client(
                    hostname=settings.mqtt_host,
                    port=settings.mqtt_port,
                    username=settings.mqtt_admin_user,
                    password=settings.mqtt_admin_password,
                    identifier=f"server-{uuid.uuid4().hex[:6]}",
                    keepalive=30,
                    max_queued_outgoing_messages=10000,
                ) as client:
                    self.client = client
                    # Читання повідомлень запускаємо одразу: відповіді dynamic security приходять через нього.
                    reader = asyncio.create_task(self._reader(client))
                    try:
                        await client.subscribe(f"{DYNSEC_TOPIC}/response", qos=1)
                        self.connected.set()
                        await self._ensure_server_acl()
                        await client.subscribe("dm/v1/+/status", qos=1)
                        await client.subscribe("dm/v1/+/telemetry", qos=0)
                        await client.subscribe("dm/v1/+/cmd/ack", qos=1)
                        log.info("Підключено до брокера %s:%s", settings.mqtt_host, settings.mqtt_port)
                        await reader
                    finally:
                        reader.cancel()
            except aiomqtt.MqttError as e:
                log.warning("MQTT: %s, повтор через 3 с", e)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("MQTT: несподівана помилка")
            self.connected.clear()
            self.client = None
            await asyncio.sleep(3)

    async def _reader(self, client: aiomqtt.Client) -> None:
        async for msg in client.messages:
            try:
                await self._on_message(str(msg.topic), msg.payload)
            except Exception:
                log.exception("Помилка обробки %s", msg.topic)

    async def publish(self, topic: str, payload: dict | str | None, qos: int = 1, retain: bool = False) -> bool:
        if not self.client:
            return False
        data = b"" if payload is None else (payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False))
        try:
            await self.client.publish(topic, data, qos=qos, retain=retain)
            return True
        except aiomqtt.MqttError as e:
            log.warning("Не вдалося надіслати %s: %s", topic, e)
            return False

    # ---------- dynamic security ----------
    async def dynsec(self, *commands: dict) -> list[dict]:
        await asyncio.wait_for(self.connected.wait(), timeout=10)
        futs = []
        for c in commands:
            cid = uuid.uuid4().hex
            c = {**c, "correlationData": cid}
            fut = asyncio.get_running_loop().create_future()
            self.pending_dynsec[cid] = fut
            futs.append((cid, c, fut))
        await self.publish(DYNSEC_TOPIC, {"commands": [c for _, c, _ in futs]})
        out = []
        for cid, _, fut in futs:
            try:
                out.append(await asyncio.wait_for(fut, timeout=10))
            except asyncio.TimeoutError:
                out.append({"error": "timeout"})
            finally:
                self.pending_dynsec.pop(cid, None)
        return out

    async def _ensure_server_acl(self) -> None:
        # Обліковому запису сервера потрібне право публікувати в теми модулів (cmd, config).
        role = "dm-server"
        await self.dynsec(
            {"command": "createRole", "rolename": role, "acls": [
                {"acltype": "publishClientSend", "topic": "dm/v1/#", "priority": 0, "allow": True},
                {"acltype": "subscribePattern", "topic": "dm/v1/#", "priority": 0, "allow": True},
                {"acltype": "publishClientReceive", "topic": "dm/v1/#", "priority": 0, "allow": True},
            ]},
            {"command": "addClientRole", "username": settings.mqtt_admin_user, "rolename": role, "priority": 10},
        )

    async def set_module_credentials(self, module_id: str, password: str) -> None:
        role = f"m-{module_id}"
        base = f"dm/v1/{module_id}"
        acls = [
            {"acltype": "publishClientSend", "topic": f"{base}/status", "allow": True},
            {"acltype": "publishClientSend", "topic": f"{base}/telemetry", "allow": True},
            {"acltype": "publishClientSend", "topic": f"{base}/cmd/ack", "allow": True},
            {"acltype": "subscribeLiteral", "topic": f"{base}/cmd", "allow": True},
            {"acltype": "subscribeLiteral", "topic": f"{base}/config", "allow": True},
        ]
        await self.dynsec(
            {"command": "deleteClient", "username": module_id},
            {"command": "createRole", "rolename": role, "acls": acls},
        )
        res = await self.dynsec(
            {"command": "createClient", "username": module_id, "password": password,
             "roles": [{"rolename": role}]},
        )
        if res[0].get("error"):
            raise RuntimeError(f"dynsec createClient: {res[0]['error']}")

    async def delete_module_credentials(self, module_id: str) -> None:
        await self.dynsec(
            {"command": "deleteClient", "username": module_id},
            {"command": "deleteRole", "rolename": f"m-{module_id}"},
        )

    # ---------- вхідні повідомлення ----------
    async def _on_message(self, topic: str, payload: bytes) -> None:
        self.stats["messages"] += 1
        if topic.startswith("$CONTROL"):
            data = json.loads(payload)
            for r in data.get("responses", []):
                fut = self.pending_dynsec.get(r.get("correlationData"))
                if fut and not fut.done():
                    fut.set_result(r)
            return
        parts = topic.split("/")
        if len(parts) < 4 or not ID_RE.match(parts[2]):
            return
        mid = parts[2]
        kind = "/".join(parts[3:])
        if not payload:
            return  # очищення retained-повідомлення
        try:
            data = json.loads(payload)
        except ValueError:
            log.warning("Некоректний JSON від %s у %s", mid, kind)
            return
        if not isinstance(data, dict):
            return
        if kind == "telemetry":
            self._on_telemetry(mid, data)
        elif kind == "status":
            await self._on_status(mid, data)
        elif kind == "cmd/ack":
            await self._on_ack(mid, data)

    def _on_telemetry(self, mid: str, data: dict) -> None:
        m = self.modules.get(mid)
        if m is None:
            return
        samples = data.get("samples") if isinstance(data.get("samples"), list) else [data]
        now_ms = int(time.time() * 1000)
        latest = None
        for s in samples:
            if not isinstance(s, dict) or not isinstance(s.get("values"), dict):
                continue
            ts = s.get("ts")
            if not isinstance(ts, (int, float)) or ts <= 0 or ts > now_ms + 60_000:
                ts = now_ms
            t = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
            clean = {}
            for k, v in s["values"].items():
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not METRIC_RE.match(k):
                    continue
                if v != v or v in (float("inf"), float("-inf")):
                    continue
                clean[k] = v
                self.rows.append((t, mid, k, float(v)))
            if clean:
                hub.telemetry(mid, int(ts), clean)
                rules_engine.feed(mid, int(ts), clean)
                if latest is None or ts >= latest[0]:
                    latest = (ts, clean)
        if len(self.rows) > 200_000:  # аварійний запобіжник, якщо база недоступна
            drop = len(self.rows) - 200_000
            del self.rows[:drop]
            self.stats["dropped"] += drop
        alarms = data.get("alarms")
        if isinstance(alarms, list):
            alarms = sorted({a for a in alarms if isinstance(a, str) and METRIC_RE.match(a)})
            old_alarms = set(m.get("alarms") or [])
            if set(alarms) != old_alarms:
                m["alarms"] = alarms  # одразу, щоб наступне повідомлення не повторило подію
                values = {**(m.get("last_values") or {}), **(latest[1] if latest else {})}
                asyncio.create_task(self._alarms_changed(mid, old_alarms, alarms, values))
        if latest:
            m["last_values"] = {**(m.get("last_values") or {}), **latest[1]}
            m["last_seen_at"] = now_utc()
            if not m.get("online"):
                # дані знову йдуть (після тиші або перезапуску сервера)
                m["online"] = True
                hub.broadcast({"type": "module", "data": public_module(m)})
            self.dirty_latest.add(mid)

    async def _alarms_changed(self, mid: str, old: set[str], alarms: list[str], values: dict) -> None:
        """Модуль повідомив інший набір показників поза нормою: події й підсвітка в інтерфейсі."""
        m = self.modules.get(mid)
        if m is None:
            return
        hub.broadcast({"type": "module", "data": public_module(m)})
        try:
            limits = m.get("limits") or {}
            who = m.get("name") or mid
            # Тривоги від меж на модулі йдуть і на сторінку «Сповіщення» та в канали (rules.py).
            for k in sorted(set(alarms) - old):
                text = modcfg.alarm_text(k, values.get(k), limits.get(k))
                await db.add_event(mid, text, "alarm")
                v = values.get(k)
                await rules_engine.raise_external(mid, f"limit:{k}", "alarm", f"{who}: {text}",
                                                  float(v) if isinstance(v, (int, float)) else None)
            for k in sorted(old - set(alarms)):
                text = modcfg.normal_text(k, values.get(k))
                await db.add_event(mid, text)
                await rules_engine.clear_external(mid, f"limit:{k}", f"{who}: {text}")
            await db.p().execute("UPDATE modules SET alarms = $2 WHERE id = $1", mid, alarms)
        except Exception:
            log.exception("Не вдалося записати зміну тривог %s", mid)

    async def _on_status(self, mid: str, data: dict) -> None:
        state = data.get("state")
        if state not in ("online", "offline"):
            return
        online = state == "online"
        m = self.modules.get(mid)
        now = now_utc()
        if m is None:
            row = await db.p().fetchrow(
                "INSERT INTO modules (id, provisioned) VALUES ($1, true) "
                "ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING *", mid)
            m = dict(row)
            self.modules[mid] = m
            await db.add_event(mid, "Новий модуль")
            hub.broadcast({"type": "module_added", "id": mid})
        was_online = m.get("online")
        old_fw = m.get("fw")
        fields: dict = {"online": online, "last_status_at": now}
        if online:
            for k in ("chip", "fw", "idf", "ip", "ssid", "reset_reason", "led"):
                if k in data and (data[k] is None or isinstance(data[k], str)):
                    fields[k] = data[k]
            if isinstance(data.get("caps"), list):
                fields["caps"] = [c for c in data["caps"] if isinstance(c, str)]
            if isinstance(data.get("addons"), list):
                fields["addon_state"] = [
                    {"id": str(a.get("id", ""))[:16], "type": str(a.get("type", ""))[:16], "ok": a.get("ok") is True,
                     "builtin": a.get("builtin") is True, "hw": str(a.get("hw") or "")[:40],
                     "error": str(a.get("error") or "")[:120]}
                    for a in data["addons"][:8] if isinstance(a, dict)]
            elif "caps" in fields and "addons" not in fields["caps"]:
                fields["addon_state"] = []
            if isinstance(data.get("config_rev"), int):
                fields["applied_config_rev"] = data["config_rev"]
            fields["last_seen_at"] = now
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
        await db.p().execute(f"UPDATE modules SET {sets} WHERE id = $1", mid, *fields.values())
        m.update(fields)
        if online and not was_online:
            await db.add_event(mid, f"На зв'язку (прошивка {m.get('fw') or '?'})")
            # Модуль щойно підключився: переконаємося, що він має актуальну конфігурацію
            if m.get("applied_config_rev", 0) != m.get("config_rev", 0) or m.get("config_rev", 0) == 0:
                await self.push_config(mid)
        elif not online and was_online:
            reason = data.get("reason")
            text = {"restart": "Перезапуск", "ota": "Перезапуск після оновлення"}.get(reason, "Зв'язок втрачено")
            await db.add_event(mid, text, "info" if reason else "warning")
        if online and old_fw and fields.get("fw") and fields["fw"] != old_fw:
            await db.add_event(mid, f"Прошивку змінено: {old_fw} → {fields['fw']}")
            await self._finish_ota(mid, fields["fw"])
        hub.broadcast({"type": "module", "data": public_module(m)})

    async def _on_ack(self, mid: str, data: dict) -> None:
        cid = data.get("id")
        status = data.get("status")
        if not isinstance(cid, str) or status not in ("ok", "error", "in_progress"):
            return
        progress = data.get("progress") if isinstance(data.get("progress"), int) else None
        message = data.get("message") if isinstance(data.get("message"), str) else ""
        row = await db.p().fetchrow("SELECT name, status FROM commands WHERE id = $1 AND module_id = $2", cid, mid)
        if not row:
            return
        # Для OTA «ok» означає, що образ записано; остаточно підтверджує нова версія в status.
        if row["name"] == "ota" and status == "ok":
            status, progress, message = "in_progress", 100, message or "Записано, перезапуск"
        row = await db.p().fetchrow(
            "UPDATE commands SET status = $3, progress = COALESCE($4, progress), message = $5, updated_at = now() "
            "WHERE id = $1 AND module_id = $2 AND status NOT IN ('ok', 'error', 'timeout') RETURNING *",
            cid, mid, status, progress, message[:500])
        if row:
            if row["status"] == "error":
                await db.add_event(mid, f"Команда «{row['name']}» не виконана: {message}", "warning")
            hub.broadcast({"type": "command", "data": public_command(row)})

    async def _finish_ota(self, mid: str, fw: str) -> None:
        rows = await db.p().fetch(
            "UPDATE commands SET status = CASE WHEN params->>'version' = $2 THEN 'ok' ELSE 'error' END, "
            "message = CASE WHEN params->>'version' = $2 THEN 'Оновлено' ELSE 'Модуль стартував з іншою версією: ' || $2 END, "
            "updated_at = now() WHERE module_id = $1 AND name = 'ota' AND status IN ('sent', 'in_progress') RETURNING *",
            mid, fw)
        for r in rows:
            hub.broadcast({"type": "command", "data": public_command(r)})

    # ---------- фонові задачі ----------
    async def _flush(self) -> None:
        if not self.rows:
            return
        rows, self.rows = self.rows, []
        try:
            async with db.p().acquire() as conn:
                await conn.copy_records_to_table("telemetry", records=rows, columns=["time", "module_id", "metric", "value"])
            self.stats["rows"] += len(rows)
        except Exception:
            log.exception("Не вдалося записати %d рядків телеметрії, повтор", len(rows))
            self.rows[:0] = rows

    async def _flusher(self) -> None:
        while True:
            await asyncio.sleep(1)
            await self._flush()

    async def _latest_pusher(self) -> None:
        """Раз на 2 с: розсилає інтерфейсу останні значення змінених модулів і зберігає їх у таблиці модулів."""
        tick = 0
        while True:
            await asyncio.sleep(2)
            tick += 1
            if not self.dirty_latest:
                continue
            ids, self.dirty_latest = self.dirty_latest, set()
            payload = {}
            for mid in ids:
                m = self.modules.get(mid)
                if m:
                    payload[mid] = {"last_values": m.get("last_values"), "last_seen_at": m.get("last_seen_at"),
                                    "online": m.get("online")}
            hub.broadcast({"type": "latest", "data": payload})
            try:
                await db.p().executemany(
                    "UPDATE modules SET last_values = $2, last_seen_at = $3, online = $4 WHERE id = $1",
                    [(mid, v["last_values"], v["last_seen_at"], v["online"]) for mid, v in payload.items()])
            except Exception:
                log.exception("Не вдалося оновити останні значення")

    async def _command_watchdog(self) -> None:
        while True:
            await asyncio.sleep(5)
            try:
                rows = await db.p().fetch(
                    "UPDATE commands SET status = 'timeout', message = 'Немає відповіді', updated_at = now() "
                    "WHERE (status = 'sent' AND name <> 'ota' AND updated_at < now() - make_interval(secs => $1)) "
                    "   OR (status IN ('sent', 'in_progress') AND name = 'ota' AND updated_at < now() - make_interval(secs => $2)) "
                    "RETURNING *", settings.cmd_timeout_s, settings.ota_timeout_s)
                for r in rows:
                    hub.broadcast({"type": "command", "data": public_command(r)})
            except Exception:
                log.exception("watchdog")

    async def _silence_watchdog(self) -> None:
        """Модуль, що зник без Last Will (наприклад, брокер ще не помітив обрив), позначаємо як «немає зв'язку»,
        якщо від нього немає даних довше 3 інтервалів + 30 с (але не менше 90 с)."""
        while True:
            await asyncio.sleep(15)
            try:
                default = int(await db.get_setting("default_interval_s") or 1)
                # У гібридному режимі модуль у нормі надсилає рідше: чекаємо за довшим інтервалом.
                rows = await db.p().fetch(
                    "SELECT m.id, GREATEST(COALESCE(m.interval_s, g.interval_s, $1), "
                    "COALESCE((m.hybrid->>'normal_interval_s')::int, 0)) AS i FROM modules m "
                    "LEFT JOIN groups g ON g.id = m.group_id WHERE m.online", default)
                now = now_utc()
                for r in rows:
                    m = self.modules.get(r["id"])
                    if not m or not m.get("online"):
                        continue
                    seen = m.get("last_seen_at") or m.get("last_status_at")
                    limit = max(90, r["i"] * 3 + 30)
                    if seen and (now - seen).total_seconds() > limit:
                        m["online"] = False
                        await db.p().execute("UPDATE modules SET online = false WHERE id = $1", r["id"])
                        await db.add_event(r["id"], "Немає даних, модуль вважається відключеним", "warning")
                        hub.broadcast({"type": "module", "data": public_module(m)})
            except Exception:
                log.exception("silence watchdog")

    # ---------- команди й конфігурація ----------
    async def effective_interval(self, mid: str) -> int:
        row = await db.p().fetchrow(
            "SELECT COALESCE(m.interval_s, g.interval_s) AS i FROM modules m "
            "LEFT JOIN groups g ON g.id = m.group_id WHERE m.id = $1", mid)
        if row and row["i"]:
            return row["i"]
        return int(await db.get_setting("default_interval_s") or 1)

    async def push_config(self, mid: str) -> None:
        interval = await self.effective_interval(mid)
        rev = await db.p().fetchval(
            "UPDATE modules SET config_rev = config_rev + 1 WHERE id = $1 RETURNING config_rev", mid)
        if rev is None:
            return
        if mid in self.modules:
            self.modules[mid]["config_rev"] = rev
        cfg = {"rev": rev, "interval_s": interval, **modcfg.config_extra(self.modules.get(mid, {}))}
        await self.publish(f"dm/v1/{mid}/config", cfg, qos=1, retain=True)

    async def send_command(self, mid: str, name: str, params: dict, batch_id: str | None = None) -> dict:
        cid = uuid.uuid4().hex[:16]
        row = await db.p().fetchrow(
            "INSERT INTO commands (id, module_id, name, params, status, batch_id) VALUES ($1, $2, $3, $4, 'sent', $5) RETURNING *",
            cid, mid, name, params, batch_id)
        ok = await self.publish(f"dm/v1/{mid}/cmd", {"id": cid, "name": name, "params": params}, qos=1)
        if not ok:
            row = await db.p().fetchrow(
                "UPDATE commands SET status = 'error', message = 'Брокер недоступний' WHERE id = $1 RETURNING *", cid)
        cmd = public_command(row)
        hub.broadcast({"type": "command", "data": cmd})
        return cmd

    async def forget_module(self, mid: str) -> None:
        self.modules.pop(mid, None)
        await self.publish(f"dm/v1/{mid}/status", None, retain=True)
        await self.publish(f"dm/v1/{mid}/config", None, retain=True)


def public_module(m: dict) -> dict:
    keys = ("id", "name", "note", "group_id", "chip", "fw", "idf", "ip", "ssid", "reset_reason", "led", "caps",
            "online", "interval_s", "hybrid", "filters", "limits", "alarms", "addons", "addon_state", "config_rev", "applied_config_rev", "provisioned", "provision_denied_at",
            "last_values", "last_seen_at", "last_status_at", "created_at")
    return {k: m.get(k) for k in keys}


def public_command(r) -> dict:
    return {k: r[k] for k in ("id", "module_id", "name", "params", "status", "progress", "message", "batch_id",
                              "created_at", "updated_at")}


mqtt = MqttService()
