import json
from pathlib import Path

import asyncpg

from .config import settings

pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def connect() -> None:
    global pool
    pool = await asyncpg.create_pool(settings.db_dsn, min_size=2, max_size=10, init=_init_conn)
    sql = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")
    async with pool.acquire() as conn:
        await conn.execute(sql)


async def close() -> None:
    if pool:
        await pool.close()


def p() -> asyncpg.Pool:
    assert pool is not None
    return pool


async def get_setting(key: str):
    return await p().fetchval("SELECT value FROM settings WHERE key = $1", key)


async def get_settings() -> dict:
    rows = await p().fetch("SELECT key, value FROM settings")
    return {r["key"]: r["value"] for r in rows}


async def add_event(module_id: str | None, message: str, level: str = "info") -> None:
    await p().execute(
        "INSERT INTO events (module_id, level, message) VALUES ($1, $2, $3)", module_id, level, message
    )


async def apply_retention(raw_days: int | None, m1_days: int | None, h1_days: int | None) -> None:
    """Оновлює політики зберігання TimescaleDB. None = зберігати без обмеження."""
    async with p().acquire() as conn:
        for rel, days in (("telemetry", raw_days), ("telemetry_1m", m1_days), ("telemetry_1h", h1_days)):
            await conn.execute(f"SELECT remove_retention_policy('{rel}', if_exists => TRUE)")
            if days:
                await conn.execute(
                    f"SELECT add_retention_policy('{rel}', make_interval(days => $1))", int(days)
                )
