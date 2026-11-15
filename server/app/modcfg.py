"""Обробка показників на модулі (етап 2, docs/PROTOCOL.md 3.5): фільтри, межі норми, гібридний режим.
Налаштування зберігаються в таблиці modules і передаються модулю в retained-темі config."""
from typing import Literal

from pydantic import BaseModel, Field, model_validator

METRIC = r"^[a-z0-9_]{1,32}$"

# Назви показників для подій (як в інтерфейсі)
METRIC_LABELS = {
    "rssi": ("Рівень Wi-Fi", "дБм"),
    "chip_temp_c": ("Температура чипа", "°C"),
    "uptime_s": ("Час роботи", "с"),
    "heap_free": ("Вільна пам'ять", "байт"),
    "heap_min_free": ("Мінімум вільної пам'яті", "байт"),
}


class Hybrid(BaseModel):
    normal_interval_s: int = Field(60, ge=1, le=3600)  # як часто надсилати, поки все в нормі
    history_s: int = Field(60, ge=0, le=60)  # передісторія, що йде разом із тривогою


class Filter(BaseModel):
    type: Literal["avg", "median", "ema"]
    window: int = Field(5, ge=2, le=30)  # avg, median: скільки останніх вимірів
    alpha: float = Field(0.2, ge=0.01, le=1)  # ema: вага нового виміру

    def wire(self) -> dict:
        return {"type": self.type, "alpha": self.alpha} if self.type == "ema" else {"type": self.type, "window": self.window}


class Limit(BaseModel):
    min: float | None = None
    max: float | None = None
    hyst: float = Field(0, ge=0)  # запас повернення в норму

    @model_validator(mode="after")
    def check(self):
        if self.min is None and self.max is None:
            raise ValueError("потрібна хоча б одна межа: min або max")
        if self.min is not None and self.max is not None and self.min >= self.max:
            raise ValueError("min має бути менше за max")
        return self

    def wire(self) -> dict:
        out: dict = {k: v for k, v in (("min", self.min), ("max", self.max)) if v is not None}
        if self.hyst:
            out["hyst"] = self.hyst
        return out


def validate_metrics(d: dict) -> None:
    import re
    for k in d:
        if not re.match(METRIC, k):
            raise ValueError(f"Некоректна назва показника: {k}")


def config_extra(m: dict) -> dict:
    """Поля конфігурації етапу 2 для модуля m (з кешу MqttService.modules)."""
    out: dict = {}
    if m.get("hybrid"):
        out["hybrid"] = Hybrid(**m["hybrid"]).model_dump()
    if m.get("filters"):
        out["filters"] = {k: Filter(**v).wire() for k, v in m["filters"].items()}
    if m.get("limits"):
        out["limits"] = {k: Limit(**v).wire() for k, v in m["limits"].items()}
    return out


def _fmt(metric: str, v) -> str:
    label, unit = METRIC_LABELS.get(metric, (metric, ""))
    if isinstance(v, (int, float)):
        val = f"{v:.1f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
        return f"{label} {val}{' ' + unit if unit else ''}"
    return label


def alarm_text(metric: str, value, limit: dict | None) -> str:
    text = f"Тривога: {_fmt(metric, value)}"
    if limit and isinstance(value, (int, float)):
        if limit.get("max") is not None and value > limit["max"]:
            text += f", вище межі {limit['max']:g}"
        elif limit.get("min") is not None and value < limit["min"]:
            text += f", нижче межі {limit['min']:g}"
    return text


def normal_text(metric: str, value) -> str:
    return f"Повернулося в норму: {_fmt(metric, value)}"
