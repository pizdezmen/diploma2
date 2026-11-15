"""Обробка показників на модулі (етап 2, docs/PROTOCOL.md 3.5): фільтри, межі норми, гібридний режим.
Налаштування зберігаються в таблиці modules і передаються модулю в retained-темі config."""
import json
from typing import Annotated, Literal, Union

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


# ---------- Доповнення модуля (docs/PROTOCOL.md 3.7) ----------
# Доповнення — пристрій, що підключається до плати (поки екрани). Кожен тип описується своєю моделлю
# з полем type; список типів — ADDON_TYPES. Щоб додати новий тип, достатньо моделі й підтримки в прошивці.
ADDON_ID = r"^[a-z0-9_-]{1,16}$"
# Службові пункти, які екран може показати поряд із показниками
DISPLAY_SERVICE_ITEMS = {"@name", "@id", "@fw", "@ip", "@ssid", "@link"}
# Пункти з даними, яких немає на самому модулі (PROTOCOL.md 3.7.3):
#   @text    сталий текст із сайту (модуль отримує його в конфігурації)
#   @remote  показник іншого модуля (сервер пересилає значення командою screen)
#   @msg     повідомлення від правила автоматизації, місце 1–4 (дія правила «Вивести на екран»)
DISPLAY_DATA_ITEMS = {"@text", "@remote", "@msg"}
DISPLAY_ITEM_SRC = r"^(@[a-z]{1,15}|[a-z0-9_]{1,32})$"
MODULE_ID = r"^[0-9a-f]{12}$"
SCREEN_SLOTS = 4
SCREEN_TEXT_MAX = 60  # символів; на екрані 21 у рядку, великим видом до 6 рядків
# Короткі підписи й одиниці на екрані 128 px (21 символ у рядку), якщо користувач не задав свої
DISPLAY_DEFAULTS = {
    "@name": ("Модуль", ""), "@id": ("ID", ""), "@fw": ("Прошивка", ""), "@ip": ("IP", ""),
    "@ssid": ("Мережа", ""), "@link": ("Зв'язок", ""),
    "rssi": ("Wi-Fi", "дБм"), "chip_temp_c": ("Темп. чипа", "°C"), "uptime_s": ("Працює", ""),
    "heap_free": ("Пам'ять", "Б"), "heap_min_free": ("Мін. пам'ять", "Б"),
}


class DisplayItem(BaseModel):
    src: str = Field(pattern=DISPLAY_ITEM_SRC)  # назва показника або службовий пункт (@name, @link ...)
    label: str = Field("", max_length=24)       # підпис на екрані; порожньо = назва показника
    unit: str = Field("", max_length=8)
    text: str = Field("", max_length=SCREEN_TEXT_MAX)  # @text
    module: str | None = Field(None, pattern=MODULE_ID)  # @remote: чий показник
    metric: str | None = Field(None, pattern=METRIC)     # @remote: який показник
    slot: int = Field(1, ge=1, le=SCREEN_SLOTS)          # @msg: місце для повідомлення правила

    @model_validator(mode="after")
    def check(self):
        if self.src.startswith("@") and self.src not in DISPLAY_SERVICE_ITEMS | DISPLAY_DATA_ITEMS:
            raise ValueError(f"невідомий службовий пункт {self.src}")
        if self.src == "@remote" and (not self.module or not self.metric):
            raise ValueError("для показника іншого модуля оберіть модуль і показник")
        return self

    def screen_key(self) -> str | None:
        """Ключ даних, які для цього пункту надсилає сервер (без «$»), або None."""
        if self.src == "@remote":
            return f"{self.module}.{self.metric}"
        if self.src == "@msg":
            return f"msg{self.slot}"
        return None

    def wire(self) -> dict:
        if self.src == "@text":
            it = {"src": "@text", "label": self.label, "text": self.text}
        elif key := self.screen_key():
            label, unit = DISPLAY_DEFAULTS.get(self.metric or "", ("", "")) if self.src == "@remote" else ("", "")
            it = {"src": "$" + key, "label": self.label or label}
            if u := (self.unit or unit):
                it["unit"] = u
        else:
            label, unit = DISPLAY_DEFAULTS.get(self.src, (self.src, ""))
            it = {"src": self.src, "label": self.label or label}
            if u := (self.unit or unit):
                it["unit"] = u
        return it


class DisplayAddon(BaseModel):
    type: Literal["display"]
    id: str = Field(pattern=ADDON_ID)
    title: str = Field("", max_length=40)       # назва для людини в інтерфейсі, модулю не надсилається
    enabled: bool = True
    driver: Literal["ssd1306", "ssd1315", "sh1106"] = "ssd1306"
    sda: int = Field(ge=0, le=48)
    scl: int = Field(ge=0, le=48)
    addr: int = Field(0x3C, ge=0x08, le=0x77)
    height: Literal[64, 32] = 64
    flip: bool = False                          # повернути зображення на 180°
    button: int = Field(-1, ge=-1, le=48)       # кнопка, що будить екран і гортає сторінки; -1 = немає
    brightness: int = Field(100, ge=1, le=100)  # відсотки
    off_after_s: int = Field(0, ge=0, le=86400)  # гасити через N с після пробудження; 0 = не гасити
    view: Literal["big", "list", "cycle"] = "list"
    cycle_s: int = Field(5, ge=1, le=3600)      # зміна пункту (cycle) або сторінки списку
    items: list[DisplayItem] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def check(self):
        if self.sda == self.scl:
            raise ValueError("SDA і SCL мають бути на різних виводах")
        if self.button in (self.sda, self.scl):
            raise ValueError("кнопка не може бути на виводі екрана")
        return self

    def wire(self) -> dict:
        out = self.model_dump(exclude={"title"})
        out["items"] = [i.wire() for i in self.items]
        return out


class LedAddon(BaseModel):
    """Вбудований світлодіод. Його не додають і не прибирають, із сайту лише змінюють підключення,
    якщо прошивка вгадала не те для конкретної плати. Керування — команда led."""
    type: Literal["led"]
    id: Literal["led"] = "led"
    title: str = Field("", max_length=40)
    driver: Literal["gpio", "ws2812"]
    gpio: int = Field(ge=0, le=48)
    active_low: bool = False
    color: str = Field("#00ff00", pattern=r"^#[0-9a-fA-F]{6}$")  # для «увімк.», блимання, дихання
    brightness: int = Field(20, ge=1, le=100)
    period_ms: int = Field(500, ge=100, le=10000)  # період блимання, дихання, веселки
    show_status: bool = False  # коли вимкнено вручну: зелений / жовтий (немає зв'язку) / червоний (поза нормою)

    def wire(self) -> dict:
        return self.model_dump(exclude={"title"})


Addon = Annotated[Union[DisplayAddon, LedAddon], Field(discriminator="type")]
ADDON_TYPES = {"display": DisplayAddon, "led": LedAddon}
ADDONS_MAX = 4
CONFIG_MAX_BYTES = 3800  # модуль зберігає конфігурацію в NVS (до 4000 байт) і приймає до 4 КБ


def check_addons(addons: list) -> None:
    ids = [a.id for a in addons]
    if len(ids) != len(set(ids)):
        raise ValueError("ідентифікатори доповнень мають бути різними")
    if len([a for a in addons if a.type != "led"]) > ADDONS_MAX:
        raise ValueError(f"не більше {ADDONS_MAX} доповнень на модуль")
    leds = [a for a in addons if a.type == "led"]
    displays = [a for a in addons if a.type == "display"]
    for led in leds:
        for d in displays:
            if led.gpio in (d.sda, d.scl, d.button):
                raise ValueError(f"GPIO{led.gpio} світлодіода зайнятий екраном {d.title or d.id}")
    for i, a in enumerate(displays):
        for b in displays[i + 1:]:
            if {a.sda, a.scl} == {b.sda, b.scl} and a.addr == b.addr:
                raise ValueError(f"екрани {a.id} і {b.id} на одній шині з однаковою адресою 0x{a.addr:02X}")


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
    addons = [ADDON_TYPES[a["type"]](**a) for a in (m.get("addons") or []) if a.get("type") in ADDON_TYPES]
    if addons:
        out["addons"] = [a.wire() for a in addons]
        if any(i.src == "@name" for a in addons if a.type == "display" for i in a.items):
            out["name"] = m.get("name") or ""
    return out


def screen_keys(m: dict) -> dict[str, DisplayItem]:
    """Які дані з сервера потрібні увімкненим екранам модуля m: ключ → пункт."""
    out: dict[str, DisplayItem] = {}
    for a in m.get("addons") or []:
        if a.get("type") != "display" or a.get("enabled") is False:
            continue
        for it in a.get("items") or []:
            if it.get("src") in ("@remote", "@msg"):
                try:
                    item = DisplayItem(**it)
                except ValueError:
                    continue
                out[item.screen_key()] = item
    return out


def screen_value(metric: str, v) -> str:
    """Значення показника для екрана (одиниці додає сам модуль)."""
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return ""
    if metric == "uptime_s":
        s = int(v)
        d, h, mi = s // 86400, s // 3600 % 24, s // 60 % 60
        return f"{d}д {h:02d}:{mi:02d}" if d else f"{h:02d}:{mi:02d}:{s % 60:02d}"
    if float(v).is_integer():
        return str(int(v))
    return f"{v:.1f}"


def clip_utf8(s: str, max_bytes: int) -> str:
    b = s.encode()
    return s if len(b) <= max_bytes else b[:max_bytes].decode("utf-8", "ignore")


def config_size(cfg: dict) -> int:
    return len(json.dumps(cfg, ensure_ascii=False, separators=(",", ":")).encode())


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
