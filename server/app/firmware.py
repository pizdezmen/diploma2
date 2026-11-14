"""Розбір образу застосунку ESP-IDF (.bin): тип чипа і версія з esp_app_desc_t."""
import struct

CHIPS = {0x0000: "esp32", 0x0002: "esp32s2", 0x0005: "esp32c3", 0x0009: "esp32s3", 0x000C: "esp32c2",
         0x000D: "esp32c6", 0x0010: "esp32h2"}
APP_DESC_MAGIC = 0xABCD5432


class FirmwareError(ValueError):
    pass


def _cstr(b: bytes) -> str:
    return b.split(b"\0", 1)[0].decode("utf-8", errors="replace")


def parse_app_image(data: bytes) -> dict:
    # esp_image_header_t (24 байти) + esp_image_segment_header_t (8 байт) + esp_app_desc_t
    if len(data) < 24 + 8 + 256:
        raise FirmwareError("Файл замалий для образу прошивки")
    if data[0] != 0xE9:
        raise FirmwareError("Це не образ застосунку ESP (немає 0xE9 на початку). Потрібен файл <project>.bin із build/, не merged і не bootloader")
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
