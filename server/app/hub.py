"""Живі оновлення для інтерфейсу через WebSocket."""
import asyncio
import json

from fastapi import WebSocket


class Client:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.modules: set[str] = set()  # на які модулі підписано потік телеметрії
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=2000)


class Hub:
    def __init__(self) -> None:
        self.clients: set[Client] = set()

    def add(self, c: Client) -> None:
        self.clients.add(c)

    def remove(self, c: Client) -> None:
        self.clients.discard(c)

    def _put(self, c: Client, text: str) -> None:
        try:
            c.queue.put_nowait(text)
        except asyncio.QueueFull:
            pass  # повільний клієнт: пропускаємо, графік покаже розрив

    def broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        text = json.dumps(msg, ensure_ascii=False, default=str)
        for c in self.clients:
            self._put(c, text)

    def telemetry(self, module_id: str, ts_ms: int, values: dict) -> None:
        targets = [c for c in self.clients if module_id in c.modules]
        if not targets:
            return
        text = json.dumps({"type": "telemetry", "module": module_id, "ts": ts_ms, "values": values})
        for c in targets:
            self._put(c, text)


hub = Hub()
