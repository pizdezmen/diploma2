"""API етапу 3: правила, тривоги, канали сповіщень."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import auth, db
from .rules import (ALERT_SQL, CHANNEL_TYPES, LEVELS, METRICS, RuleError, describe_trigger, engine, mask_channel,
                    send_channels, validate)
from .hub import hub

router = APIRouter(prefix="/api", dependencies=[Depends(auth.require_user)])


# ---------------- правила ----------------
def _public_rule(r) -> dict:
    d = dict(r)
    d["summary"] = describe_trigger(d["trigger"])
    d["active"] = sum(1 for (rid, _), st in engine.state.items() if rid == d["id"] and st.active)
    return d


@router.get("/rules")
async def list_rules():
    rows = await db.p().fetch("SELECT * FROM rules ORDER BY name, id")
    return [_public_rule(r) for r in rows]


@router.get("/rules/meta")
async def rules_meta():
    """Що можна обрати у формі правила: відомі показники, рівні, типи каналів."""
    seen = await db.p().fetch("SELECT DISTINCT metric FROM telemetry WHERE time > now() - interval '1 day'")
    metrics = {k: {"label": v[0], "unit": v[1]} for k, v in METRICS.items()}
    for r in seen:
        metrics.setdefault(r["metric"], {"label": r["metric"], "unit": ""})
    tz = await db.get_setting("timezone")
    return {
        "metrics": metrics,
        "levels": list(LEVELS),
        "timezone": tz,
        "channel_types": [{"type": c.type, "title": c.title, "fields": c.fields} for c in CHANNEL_TYPES.values()],
    }


async def _save(rule_id: int | None, body: dict) -> dict:
    try:
        f = validate(body)
    except RuleError as e:
        raise HTTPException(400, str(e))
    cols = list(f)
    if rule_id is None:
        sql = (f"INSERT INTO rules ({', '.join(cols)}) VALUES ({', '.join(f'${i + 1}' for i in range(len(cols)))}) "
               "RETURNING *")
        row = await db.p().fetchrow(sql, *f.values())
    else:
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(cols))
        row = await db.p().fetchrow(f"UPDATE rules SET {sets} WHERE id = $1 RETURNING *", rule_id, *f.values())
        if not row:
            raise HTTPException(404, "Правило не знайдено")
    await engine.rule_changed(row["id"])
    return _public_rule(row)


@router.post("/rules")
async def create_rule(body: dict):
    return await _save(None, body)


@router.put("/rules/{rid}")
async def update_rule(rid: int, body: dict):
    return await _save(rid, body)


class EnabledIn(BaseModel):
    enabled: bool


@router.post("/rules/{rid}/enabled")
async def set_enabled(rid: int, body: EnabledIn):
    row = await db.p().fetchrow("UPDATE rules SET enabled = $2 WHERE id = $1 RETURNING *", rid, body.enabled)
    if not row:
        raise HTTPException(404, "Правило не знайдено")
    await engine.rule_changed(rid)
    return _public_rule(row)


@router.delete("/rules/{rid}")
async def delete_rule(rid: int):
    await db.p().execute("DELETE FROM rules WHERE id = $1", rid)
    await engine.rule_changed(rid)
    return {"ok": True}


@router.post("/rules/{rid}/run")
async def run_rule(rid: int):
    """Виконати дії правила за розкладом негайно (щоб перевірити)."""
    row = await db.p().fetchrow("SELECT * FROM rules WHERE id = $1", rid)
    if not row:
        raise HTTPException(404, "Правило не знайдено")
    if row["trigger"].get("type") != "schedule":
        raise HTTPException(400, "Вручну можна виконати лише правило за розкладом")
    return {"message": await engine.run_schedule(dict(row))}


# ---------------- тривоги ----------------
@router.get("/alerts")
async def list_alerts(active: bool = False, limit: int = Query(200, le=2000)):
    if active:
        rows = await db.p().fetch(ALERT_SQL + " WHERE a.ended_at IS NULL ORDER BY a.started_at DESC")
    else:
        rows = await db.p().fetch(ALERT_SQL + " ORDER BY a.started_at DESC LIMIT $1", limit)
    return [dict(r) for r in rows]


@router.post("/alerts/{aid}/ack")
async def ack_alert(aid: int):
    await db.p().execute("UPDATE alerts SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL", aid)
    row = await db.p().fetchrow(ALERT_SQL + " WHERE a.id = $1", aid)
    if not row:
        raise HTTPException(404, "Тривогу не знайдено")
    hub.broadcast({"type": "alert", "data": dict(row)})
    return dict(row)


@router.post("/alerts/ack-all")
async def ack_all():
    rows = await db.p().fetch("UPDATE alerts SET acknowledged_at = now() WHERE ended_at IS NULL "
                              "AND acknowledged_at IS NULL RETURNING id")
    for r in rows:
        row = await db.p().fetchrow(ALERT_SQL + " WHERE a.id = $1", r["id"])
        hub.broadcast({"type": "alert", "data": dict(row)})
    return {"count": len(rows)}


# ---------------- канали сповіщень ----------------
class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: str
    enabled: bool = True
    min_level: str = "warning"
    config: dict = {}


def _check_channel(body: ChannelIn, old: dict | None) -> dict:
    cls = CHANNEL_TYPES.get(body.type)
    if not cls:
        raise HTTPException(400, "Невідомий тип каналу")
    if body.min_level not in LEVELS:
        raise HTTPException(400, "Невідомий рівень")
    cfg = {"send_recovery": bool(body.config.get("send_recovery", True))}
    for fdef in cls.fields:
        v = str(body.config.get(fdef["key"]) or "").strip()
        # Секретне поле приходить замасковане, якщо його не змінювали: лишаємо старе значення
        if fdef.get("secret") and old and (not v or v.startswith("••••")):
            v = (old.get("config") or {}).get(fdef["key"], "")
        cfg[fdef["key"]] = v[:500]
    return cfg


@router.get("/channels")
async def list_channels():
    rows = await db.p().fetch("SELECT * FROM notify_channels ORDER BY id")
    return [mask_channel(dict(r)) for r in rows]


@router.post("/channels")
async def create_channel(body: ChannelIn):
    cfg = _check_channel(body, None)
    row = await db.p().fetchrow(
        "INSERT INTO notify_channels (name, type, enabled, min_level, config) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        body.name.strip(), body.type, body.enabled, body.min_level, cfg)
    return mask_channel(dict(row))


@router.put("/channels/{cid}")
async def update_channel(cid: int, body: ChannelIn):
    old = await db.p().fetchrow("SELECT * FROM notify_channels WHERE id = $1", cid)
    if not old:
        raise HTTPException(404, "Канал не знайдено")
    cfg = _check_channel(body, dict(old))
    row = await db.p().fetchrow(
        "UPDATE notify_channels SET name = $2, type = $3, enabled = $4, min_level = $5, config = $6 "
        "WHERE id = $1 RETURNING *", cid, body.name.strip(), body.type, body.enabled, body.min_level, cfg)
    return mask_channel(dict(row))


@router.delete("/channels/{cid}")
async def delete_channel(cid: int):
    await db.p().execute("DELETE FROM notify_channels WHERE id = $1", cid)
    return {"ok": True}


@router.post("/channels/{cid}/test")
async def test_channel(cid: int):
    res = await send_channels("Перевірка каналу сповіщень системи моніторингу", "info", {"kind": "test"}, only_id=cid)
    if not res:
        raise HTTPException(404, "Канал не знайдено")
    if res[0]["error"]:
        raise HTTPException(502, f"Не вдалося надіслати: {res[0]['error']}")
    return {"ok": True}
