"""Розбір образу застосунку ESP-IDF (.bin): тип чипа і версія з esp_app_desc_t."""
import struct

CHIPS = {0x0000: "esp32", 0x0002: "esp32s2", 0x0005: "esp32c3", 0x0009: "esp32s3", 0x000C: "esp32c2",
         0x000D: "esp32c6", 0x0010: "esp32h2"}
APP_DESC_MAGIC = 0xABCD5432


class FirmwareError(ValueError):
    pass


def _cstr(b: bytes) -> str:
    return b.split(b"\0", 1)[0].decode("utf-8", errors="replace")


def _parse_app(data: bytes) -> dict:
    # esp_image_header_t (24 байти) + esp_image_segment_header_t (8 байт) + esp_app_desc_t
    if len(data) < 24 + 8 + 256:
        raise FirmwareError("Файл замалий для образу прошивки")
    if data[0] != 0xE9:
        raise FirmwareError("Це не образ ESP (немає 0xE9 на початку)")
    chip_id = struct.unpack_from("<H", data, 12)[0]
    desc = 24 + 8
    magic = struct.unpack_from("<I", data, desc)[0]
    if magic != APP_DESC_MAGIC:
        raise FirmwareError("Не знайдено опис застосунку (esp_app_desc_t)")
    version = _cstr(data[desc + 16: desc + 48])
    project = _cstr(data[desc + 48: desc + 80])
    btime = _cstr(data[desc + 80: desc + 96])
    bdate = _cstr(data[desc + 96: desc + 112])
    idf = _cstr(data[desc + 112: desc + 144])
    return {
        "chip": CHIPS.get(chip_id, f"0x{chip_id:04x}"),
        "version": version,
        "project": project,
        "build_time": f"{bdate} {btime}".strip(),
        "idf": idf,
    }


PARTITION_TABLE_OFFSET = 0x8000
PARTITION_MAGIC = b"\xaa\x50"


def _app_offset(data: bytes) -> int | None:
    """Шукає в таблиці розділів перший розділ застосунку (factory або ota_0)."""
    if len(data) < PARTITION_TABLE_OFFSET + 32 or data[PARTITION_TABLE_OFFSET:PARTITION_TABLE_OFFSET + 2] != PARTITION_MAGIC:
        return None
    apps = []
    for i in range(0, 0xC00, 32):
        e = data[PARTITION_TABLE_OFFSET + i: PARTITION_TABLE_OFFSET + i + 32]
        if e[:2] != PARTITION_MAGIC:
            break
        ptype, subtype = e[2], e[3]
        offset = struct.unpack_from("<I", e, 4)[0]
        if ptype == 0 and (subtype == 0 or subtype == 0x10):
            apps.append(offset)
    return min(apps) if apps else None


def parse_image(data: bytes) -> dict:
    """Розпізнає файл застосунку (для OTA) або повний образ (для запису з адреси 0)."""
    if len(data) < 24 + 8 + 256 or data[0] != 0xE9:
        raise FirmwareError("Це не образ прошивки ESP. Потрібен <project>.bin (для OTA) або повний образ з merge-bin")
    off = _app_offset(data)
    if off is None:
        return {**_parse_app(data), "kind": "app"}
    if len(data) <= off:
        raise FirmwareError("У повному образі немає застосунку")
    info = _parse_app(data[off:])
    boot_chip = CHIPS.get(struct.unpack_from("<H", data, 12)[0])
    if boot_chip and boot_chip != info["chip"]:
        raise FirmwareError(f"Завантажувач для {boot_chip}, а застосунок для {info['chip']}")
    return {**info, "kind": "full"}
