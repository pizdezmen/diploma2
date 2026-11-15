import asyncio
import hashlib
import json
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import auth, db
from .modcfg import CONFIG_MAX_BYTES, Addon, Filter, Hybrid, Limit, check_addons, config_extra, config_size, validate_metrics
from .config import settings
from .firmware import FirmwareError, parse_image
from .hub import hub
from .mqtt import ID_RE, mqtt, public_command, public_module

log = logging.getLogger("api")

public = APIRouter(prefix="/api")
api = APIRouter(prefix="/api", dependencies=[Depends(auth.require_user)])


# ---------------- вхід ----------------
class LoginIn(BaseModel):
    username: str
    password: str


@public.post("/auth/login")
async def login(body: LoginIn, request: Request, response: Response):
    if not auth.check_credentials(body.username, body.password):
        await auth.slow_down_on_failure()
        raise HTTPException(401, "Невірний логін або пароль")
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(auth.COOKIE, auth.make_token(body.username), max_age=settings.session_days * 86400,
                        httponly=True, samesite="lax", secure=secure)
    return {"username": body.username}


@public.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@api.get("/auth/me")
async def me():
    return {"username": settings.admin_username}


# ---------------- реєстрація модуля ----------------
class ProvisionIn(BaseModel):
    id: str
    chip: str = ""
    fw: str = ""
    token: str


@public.post("/provision")
async def provision(body: ProvisionIn):
    if not secrets.compare_digest(body.token, settings.provision_token):
        await auth.slow_down_on_failure()
        raise HTTPException(401, "Невірний токен реєстрації")
    mid = body.id.lower()
    if not ID_RE.match(mid):
        raise HTTPException(400, "id має бути MAC із 12 шістнадцяткових символів")
    row = await db.p().fetchrow("SELECT provisioned FROM modules WHERE id = $1", mid)
    if row and row["provisioned"]:
        await db.p().execute("UPDATE modules SET provision_denied_at = now() WHERE id = $1", mid)
        if mid in mqtt.modules:
            mqtt.modules[mid]["provision_denied_at"] = datetime.now(timezone.utc)
            hub.broadcast({"type": "module", "data": public_module(mqtt.modules[mid])})
        raise HTTPException(409, "Модуль уже зареєстрований. Скиньте пароль MQTT в інтерфейсі")
    password = secrets.token_urlsafe(24)[:32]
    try:
        await mqtt.set_module_credentials(mid, password)
    except Exception as e:
        log.exception("provision")
        raise HTTPException(503, f"Брокер недоступний: {e}")
    chip = body.chip[:16] or None
    fw = body.fw[:32] or None
    new = row is None
    r = await db.p().fetchrow(
        "INSERT INTO modules (id, chip, fw, provisioned) VALUES ($1, $2, $3, true) "
        "ON CONFLICT (id) DO UPDATE SET provisioned = true, provision_denied_at = NULL, "
        "chip = COALESCE(EXCLUDED.chip, modules.chip), fw = COALESCE(EXCLUDED.fw, modules.fw) RETURNING *",
        mid, chip, fw)
    mqtt.modules[mid] = {**mqtt.modules.get(mid, {}), **dict(r)}
    await db.add_event(mid, "Зареєстровано новий модуль" if new else "Видано новий пароль MQTT")
    hub.broadcast({"type": "module_added" if new else "module", "id": mid, "data": public_module(mqtt.modules[mid])})
    await mqtt.push_config(mid)
    return {"username": mid, "password": password}


# ---------------- модулі ----------------
def _get_module(mid: str) -> dict:
    m = mqtt.modules.get(mid)
    if not m:
        raise HTTPException(404, "Модуль не знайдено")
    return m


@api.get("/modules")
async def list_modules():
    return [public_module(m) for m in mqtt.modules.values()]


@api.get("/modules/{mid}")
async def get_module(mid: str):
    m = _get_module(mid)
    out = public_module(m)
    out["effective_interval_s"] = await mqtt.effective_interval(mid)
    out["metrics"] = [r["metric"] for r in await db.p().fetch(
        "SELECT DISTINCT metric FROM telemetry_1h WHERE module_id = $1 "
        "UNION SELECT DISTINCT metric FROM telemetry WHERE module_id = $1 AND time > now() - interval '1 hour'", mid)]
    return out


class ModulePatch(BaseModel):
    name: str | None = Field(None, max_length=100)
    note: str | None = Field(None, max_length=1000)
    group_id: int | None = None
    interval_s: int | None = Field(None, ge=1, le=3600)
    # Етап 2, обробка на модулі (docs/PROTOCOL.md 3.5); hybrid = null вимикає гібридний режим
    hybrid: Hybrid | None = None
    filters: dict[str, Filter] | None = None
    limits: dict[str, Limit] | None = None
    # Доповнення (docs/PROTOCOL.md 3.7): увесь список одразу
    addons: list[Addon] | None = None


MODULE_CONFIG_FIELDS = {"interval_s", "group_id", "hybrid", "filters", "limits", "addons"}


@api.patch("/modules/{mid}")
async def patch_module(mid: str, body: ModulePatch):
    m = _get_module(mid)
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    if not fields:
        return public_module(m)
    if "name" in fields and fields["name"] is None:
        fields["name"] = ""
    if "note" in fields and fields["note"] is None:
        fields["note"] = ""
    for k in ("filters", "limits"):
        if k in fields:
            d = fields[k] or {}
            try:
                validate_metrics(d)
            except ValueError as e:
                raise HTTPException(400, str(e))
            fields[k] = {name: v.model_dump() for name, v in d.items()}
    if "hybrid" in fields and fields["hybrid"] is not None:
        fields["hybrid"] = fields["hybrid"].model_dump()
    if "addons" in fields:
        addons = fields["addons"] or []
        try:
            check_addons(addons)
        except ValueError as e:
            raise HTTPException(400, str(e))
        fields["addons"] = [a.model_dump() for a in addons]
    # Конфігурація має влізти в пам'ять модуля
    if (size := config_size({"rev": 1, "interval_s": 1, **config_extra({**m, **fields})})) > CONFIG_MAX_BYTES:
        raise HTTPException(400, f"Забагато налаштувань для модуля: {size} байт із {CONFIG_MAX_BYTES}. Приберіть частину пунктів екранів чи меж.")
    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
    try:
        row = await db.p().fetchrow(f"UPDATE modules SET {sets} WHERE id = $1 RETURNING *", mid, *fields.values())
    except Exception as e:
        raise HTTPException(400, str(e))
    m.update(dict(row))
    # Назва модуля потрапляє на екран, якщо там вибрано пункт «Назва модуля»
    if MODULE_CONFIG_FIELDS & fields.keys() or ("name" in fields and "name" in config_extra(m)):
        await mqtt.push_config(mid)
    hub.broadcast({"type": "module", "data": public_module(m)})
    return public_module(m)


@api.delete("/modules/{mid}")
async def delete_module(mid: str):
    _get_module(mid)
    try:
        await mqtt.delete_module_credentials(mid)
    except Exception:
        log.exception("delete creds")
    await mqtt.forget_module(mid)
    async with db.p().acquire() as conn:
        await conn.execute("DELETE FROM modules WHERE id = $1", mid)
        await conn.execute("DELETE FROM commands WHERE module_id = $1", mid)
        await conn.execute("DELETE FROM events WHERE module_id = $1", mid)
    # Історію показників видаляємо у фоні: на стиснутих даних це може тривати.
    asyncio.create_task(db.p().execute("DELETE FROM telemetry WHERE module_id = $1", mid))
    hub.broadcast({"type": "module_removed", "id": mid})
    return {"ok": True}


@api.post("/modules/{mid}/reset-credentials")
async def reset_credentials(mid: str):
    m = _get_module(mid)
    await mqtt.delete_module_credentials(mid)
    await db.p().execute("UPDATE modules SET provisioned = false WHERE id = $1", mid)
    m["provisioned"] = False
    await db.add_event(mid, "Пароль MQTT скинуто, модуль може зареєструватися знову", "warning")
    hub.broadcast({"type": "module", "data": public_module(m)})
    return public_module(m)


@api.get("/modules/{mid}/telemetry")
async def module_telemetry(mid: str, frm: datetime = Query(alias="from"), to: datetime | None = None,
                           metrics: str | None = None):
    _get_module(mid)
    to = to or datetime.now(timezone.utc)
    if frm.tzinfo is None:
        frm = frm.replace(tzinfo=timezone.utc)
    if to.tzinfo is None:
        to = to.replace(tzinfo=timezone.utc)
    span = to - frm
    raw_days = await db.get_setting("retention_raw_days")
    raw_limit = datetime.now(timezone.utc) - timedelta(days=raw_days) if raw_days else None
    names = [x for x in (metrics or "").split(",") if x] or None
    if span <= timedelta(hours=3) and (raw_limit is None or frm >= raw_limit):
        source, step = "raw", None
        sql = ("SELECT time AS t, metric, value AS v, NULL::float8 AS mn, NULL::float8 AS mx FROM telemetry "
               "WHERE module_id = $1 AND time >= $2 AND time <= $3 AND ($4::text[] IS NULL OR metric = ANY($4)) "
               "ORDER BY time")
    elif span <= timedelta(days=10):
        source, step = "1m", 60
        sql = ("SELECT bucket AS t, metric, avg AS v, min AS mn, max AS mx FROM telemetry_1m "
               "WHERE module_id = $1 AND bucket >= $2 AND bucket <= $3 AND ($4::text[] IS NULL OR metric = ANY($4)) "
               "ORDER BY bucket")
    else:
        source, step = "1h", 3600
        sql = ("SELECT bucket AS t, metric, avg AS v, min AS mn, max AS mx FROM telemetry_1h "
               "WHERE module_id = $1 AND bucket >= $2 AND bucket <= $3 AND ($4::text[] IS NULL OR metric = ANY($4)) "
               "ORDER BY bucket")
    rows = await db.p().fetch(sql, mid, frm, to, names)
    series: dict[str, dict] = {}
    for r in rows:
        s = series.setdefault(r["metric"], {"t": [], "v": [], "min": [], "max": []})
        s["t"].append(int(r["t"].timestamp() * 1000))
        s["v"].append(r["v"])
        s["min"].append(r["mn"])
        s["max"].append(r["mx"])
    if source == "raw":
        for s in series.values():
            del s["min"], s["max"]
    return {"source": source, "step_s": step or await mqtt.effective_interval(mid), "series": series}


@api.get("/modules/{mid}/events")
async def module_events(mid: str, limit: int = Query(100, le=1000)):
    rows = await db.p().fetch("SELECT * FROM events WHERE module_id = $1 ORDER BY time DESC LIMIT $2", mid, limit)
    return [dict(r) for r in rows]


@api.get("/events")
async def all_events(limit: int = Query(200, le=2000)):
    rows = await db.p().fetch("SELECT * FROM events ORDER BY time DESC LIMIT $1", limit)
    return [dict(r) for r in rows]


# ---------------- команди ----------------
class CommandIn(BaseModel):
    name: str
    params: dict = {}


async def _prepare(mid: str, name: str, params: dict) -> dict:
    """Перевіряє команду й повертає параметри для модуля."""
    if name == "led":
        if params.get("mode") not in ("on", "off", "blink"):
            raise HTTPException(400, "led: mode має бути on, off або blink")
        return {"mode": params["mode"]}
    if name == "restart":
        return {}
    if name == "ota":
        fw = await db.p().fetchrow("SELECT * FROM firmware WHERE id = $1", int(params.get("firmware_id") or 0))
        if not fw:
            raise HTTPException(400, "Прошивку не знайдено")
        if fw["kind"] != "app":
            raise HTTPException(400, "Це повний образ для прошивання через USB, для оновлення по Wi-Fi потрібен файл застосунку")
        chip = mqtt.modules.get(mid, {}).get("chip")
        if chip and chip != fw["chip"]:
            raise HTTPException(400, f"Прошивка для {fw['chip']}, а модуль {chip}")
        url = f"{settings.public_url.rstrip('/')}/api/firmware/{fw['id']}/download?token={fw['token']}"
        return {"url": url, "version": fw["version"], "size": fw["size"], "sha256": fw["sha256"]}
    raise HTTPException(400, f"Невідома команда {name}")


@api.post("/modules/{mid}/commands")
async def module_command(mid: str, body: CommandIn):
    m = _get_module(mid)
    params = await _prepare(mid, body.name, body.params)
    if not m.get("online"):
        raise HTTPException(409, "Модуль не на зв'язку")
    return await mqtt.send_command(mid, body.name, params)


@api.get("/modules/{mid}/commands")
async def module_commands(mid: str, limit: int = Query(50, le=500)):
    rows = await db.p().fetch("SELECT * FROM commands WHERE module_id = $1 ORDER BY created_at DESC LIMIT $2", mid, limit)
    return [public_command(r) for r in rows]


class BulkIn(BaseModel):
    module_ids: list[str] = []
    group_id: int | None = None
    name: str
    params: dict = {}


async def _run_waves(batch_id: str, jobs: list[tuple[str, dict]], name: str, wave: int) -> None:
    for i in range(0, len(jobs), wave):
        chunk = jobs[i:i + wave]
        ids = []
        for mid, params in chunk:
            if mqtt.modules.get(mid, {}).get("online"):
                c = await mqtt.send_command(mid, name, params, batch_id)
                ids.append(c["id"])
        if name != "ota" or not ids:
            continue
        # Наступна хвиля OTA лише після завершення попередньої
        while True:
            left = await db.p().fetchval(
                "SELECT count(*) FROM commands WHERE id = ANY($1) AND status IN ('sent', 'in_progress')", ids)
            if not left:
                break
            await asyncio.sleep(3)


@api.post("/commands/bulk")
async def bulk_command(body: BulkIn):
    ids = set(body.module_ids)
    if body.group_id is not None:
        ids |= {mid for mid, m in mqtt.modules.items() if m.get("group_id") == body.group_id}
    ids = [i for i in ids if i in mqtt.modules]
    if not ids:
        raise HTTPException(400, "Не вибрано жодного модуля")
    jobs, skipped = [], []
    for mid in ids:
        try:
            jobs.append((mid, await _prepare(mid, body.name, body.params)))
        except HTTPException as e:
            skipped.append({"id": mid, "reason": e.detail})
    offline = [mid for mid, _ in jobs if not mqtt.modules[mid].get("online")]
    batch_id = uuid.uuid4().hex[:12]
    wave = int(await db.get_setting("ota_wave_size") or 10) if body.name == "ota" else 50
    asyncio.create_task(_run_waves(batch_id, jobs, body.name, max(1, wave)))
    return {"batch_id": batch_id, "queued": len(jobs) - len(offline), "offline": offline, "skipped": skipped}


# ---------------- групи ----------------
class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    interval_s: int | None = Field(None, ge=1, le=3600)
    note: str = Field("", max_length=1000)


def _group_summary(gid: int | None) -> dict:
    members = [m for m in mqtt.modules.values() if m.get("group_id") == gid]
    temps = [m["last_values"].get("chip_temp_c") for m in members if m.get("online") and m.get("last_values")]
    temps = [t for t in temps if isinstance(t, (int, float))]
    rssi = [m["last_values"].get("rssi") for m in members if m.get("online") and m.get("last_values")]
    rssi = [r for r in rssi if isinstance(r, (int, float))]
    return {"total": len(members), "online": sum(1 for m in members if m.get("online")),
            "temp_avg": round(sum(temps) / len(temps), 1) if temps else None, "temp_max": max(temps) if temps else None,
            "rssi_min": min(rssi) if rssi else None}


@api.get("/groups")
async def list_groups():
    rows = await db.p().fetch("SELECT * FROM groups ORDER BY name")
    out = [{**dict(r), **_group_summary(r["id"])} for r in rows]
    return {"groups": out, "ungrouped": _group_summary(None)}


async def _repush_group(gid: int) -> None:
    for mid, m in list(mqtt.modules.items()):
        if m.get("group_id") == gid and m.get("interval_s") is None:
            await mqtt.push_config(mid)


@api.post("/groups")
async def create_group(body: GroupIn):
    try:
        r = await db.p().fetchrow("INSERT INTO groups (name, interval_s, note) VALUES ($1, $2, $3) RETURNING *",
                                  body.name.strip(), body.interval_s, body.note)
    except Exception:
        raise HTTPException(400, "Група з такою назвою вже є")
    return dict(r)


@api.put("/groups/{gid}")
async def update_group(gid: int, body: GroupIn):
    old = await db.p().fetchrow("SELECT * FROM groups WHERE id = $1", gid)
    if not old:
        raise HTTPException(404, "Групу не знайдено")
    try:
        r = await db.p().fetchrow("UPDATE groups SET name = $2, interval_s = $3, note = $4 WHERE id = $1 RETURNING *",
                                  gid, body.name.strip(), body.interval_s, body.note)
    except Exception:
        raise HTTPException(400, "Група з такою назвою вже є")
    if old["interval_s"] != body.interval_s:
        await _repush_group(gid)
    return dict(r)


@api.delete("/groups/{gid}")
async def delete_group(gid: int):
    members = [mid for mid, m in mqtt.modules.items() if m.get("group_id") == gid]
    await db.p().execute("DELETE FROM groups WHERE id = $1", gid)
    for mid in members:
        mqtt.modules[mid]["group_id"] = None
        await mqtt.push_config(mid)
        hub.broadcast({"type": "module", "data": public_module(mqtt.modules[mid])})
    return {"ok": True}


# ---------------- прошивки ----------------
@api.get("/firmware")
async def list_firmware():
    rows = await db.p().fetch("SELECT * FROM firmware ORDER BY uploaded_at DESC")
    return [{k: v for k, v in dict(r).items() if k != "token"} for r in rows]


@api.post("/firmware")
async def upload_firmware(file: UploadFile = File(...), note: str = Form("")):
    data = await file.read()
    if len(data) > 16 * 1024 * 1024:
        raise HTTPException(400, "Файл більший за 16 МБ")
    try:
        info = parse_image(data)
    except FirmwareError as e:
        raise HTTPException(400, str(e))
    if info["chip"] not in ("esp32s3", "esp32c3"):
        raise HTTPException(400, f"Непідтримуваний чип {info['chip']}")
    if not info["version"]:
        raise HTTPException(400, "В образі не вказано версію")
    sha = hashlib.sha256(data).hexdigest()
    dup = await db.p().fetchval("SELECT id FROM firmware WHERE sha256 = $1", sha)
    if dup:
        raise HTTPException(400, "Такий файл уже завантажено")
    os.makedirs(settings.firmware_dir, exist_ok=True)
    r = await db.p().fetchrow(
        "INSERT INTO firmware (filename, chip, version, project, idf, build_time, size, sha256, token, note, kind) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *",
        (file.filename or "firmware.bin")[:200], info["chip"], info["version"], info["project"], info["idf"],
        info["build_time"], len(data), sha, secrets.token_urlsafe(24), note[:500], info["kind"])
    with open(os.path.join(settings.firmware_dir, f"{r['id']}.bin"), "wb") as f:
        f.write(data)
    return {k: v for k, v in dict(r).items() if k != "token"}


@api.delete("/firmware/{fid}")
async def delete_firmware(fid: int):
    await db.p().execute("DELETE FROM firmware WHERE id = $1", fid)
    try:
        os.remove(os.path.join(settings.firmware_dir, f"{fid}.bin"))
    except FileNotFoundError:
        pass
    return {"ok": True}


@api.get("/firmware/{fid}/file")
async def firmware_file(fid: int):
    """Файл прошивки для сайту (прошивання через USB)."""
    r = await db.p().fetchrow("SELECT * FROM firmware WHERE id = $1", fid)
    if not r:
        raise HTTPException(404, "Не знайдено")
    return FileResponse(os.path.join(settings.firmware_dir, f"{fid}.bin"), media_type="application/octet-stream",
                        filename=r["filename"])


@api.get("/provisioning")
async def provisioning():
    """Значення, які сайт записує в модуль під час додавання (docs/PROTOCOL.md, розділ 6)."""
    from urllib.parse import urlparse
    url = settings.public_url.rstrip("/")
    return {
        "server_url": url,
        "mqtt_host": settings.mqtt_public_host or urlparse(url).hostname or "",
        "mqtt_port": settings.mqtt_public_port,
        "mqtt_tls": settings.mqtt_tls,
        "token": settings.provision_token,
    }


@public.get("/firmware/{fid}/download")
async def download_firmware(fid: int, token: str):
    r = await db.p().fetchrow("SELECT * FROM firmware WHERE id = $1", fid)
    if not r or not secrets.compare_digest(token, r["token"]):
        raise HTTPException(404, "Не знайдено")
    return FileResponse(os.path.join(settings.firmware_dir, f"{fid}.bin"), media_type="application/octet-stream",
                        filename=r["filename"])


# ---------------- налаштування ----------------
class SettingsIn(BaseModel):
    retention_raw_days: int | None = Field(None, ge=1, le=3650)
    retention_1m_days: int | None = Field(None, ge=1, le=36500)
    retention_1h_days: int | None = Field(None, ge=1, le=36500)
    default_interval_s: int = Field(1, ge=1, le=3600)
    ota_wave_size: int = Field(10, ge=1, le=200)


@api.get("/settings")
async def get_settings():
    return await db.get_settings()


@api.put("/settings")
async def put_settings(body: SettingsIn):
    old = await db.get_settings()
    new = body.model_dump()
    async with db.p().acquire() as conn:
        for k, v in new.items():
            await conn.execute("INSERT INTO settings (key, value) VALUES ($1, $2::text::jsonb) "
                               "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", k, json.dumps(v))
    await db.apply_retention(body.retention_raw_days, body.retention_1m_days, body.retention_1h_days)
    if old.get("default_interval_s") != body.default_interval_s:
        for mid in list(mqtt.modules):
            if await mqtt.effective_interval(mid) == body.default_interval_s:
                await mqtt.push_config(mid)
    return await db.get_settings()


@api.get("/system")
async def system():
    return {
        "mqtt_connected": mqtt.connected.is_set(),
        "mqtt_public_port": settings.mqtt_public_port,
        "mqtt_tls": settings.mqtt_tls,
        "public_url": settings.public_url,
        "provision_token": settings.provision_token,
        "stats": mqtt.stats,
        "buffer": len(mqtt.rows),
        "modules": len(mqtt.modules),
        "online": sum(1 for m in mqtt.modules.values() if m.get("online")),
        "server_time": datetime.now(timezone.utc),
    }
