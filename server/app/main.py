import asyncio
import contextlib
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from . import auth, db
from .api import api, public
from .rules import engine as rules_engine
from .rules_api import router as rules_router
from .hub import Client, hub
from .mqtt import ID_RE, mqtt

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True)
log = logging.getLogger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    for attempt in range(30):
        try:
            await db.connect()
            break
        except Exception as e:
            log.warning("База ще недоступна (%s), чекаю", e)
            await asyncio.sleep(2)
    else:
        raise RuntimeError("Немає зв'язку з базою")
    s = await db.get_settings()
    await db.apply_retention(s.get("retention_raw_days"), s.get("retention_1m_days"), s.get("retention_1h_days"))
    await mqtt.start()
    await rules_engine.start()
    yield
    await rules_engine.stop()
    await mqtt.stop()
    await db.close()


app = FastAPI(title="Моніторинг", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(public)
app.include_router(api)
app.include_router(rules_router)


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket):
    if not auth.ws_authorized(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    client = Client(ws)
    hub.add(client)

    async def sender():
        while True:
            text = await client.queue.get()
            await ws.send_text(text)

    task = asyncio.create_task(sender())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            # {"subscribe": ["id", ...]} задає повний список модулів, чию телеметрію потрібно передавати наживо
            if isinstance(msg.get("subscribe"), list):
                client.modules = {m for m in msg["subscribe"] if isinstance(m, str) and ID_RE.match(m)}
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        hub.remove(client)
        task.cancel()
        with contextlib.suppress(BaseException):
            await task
