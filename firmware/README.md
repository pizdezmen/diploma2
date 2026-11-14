# Прошивка модуля (етап 1)

ESP-IDF, одна кодова база для ESP32-S3 (16 МБ flash, 8 МБ PSRAM) і ESP32-C3 (4 МБ flash).
Протокол обміну з сервером: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

Що вміє етап 1 (гола плата без датчиків):

- підключення до вшитої Wi-Fi мережі (основна + запасна), вибір найсильнішої точки доступу з однією назвою, перепідключення з випадковою затримкою;
- самореєстрація на сервері (`POST /api/provision`), пароль MQTT зберігається в NVS;
- MQTT: `status` (retained, Last Will `offline`), `telemetry` раз на `interval_s` (за замовчуванням 1 с), `cmd` / `cmd/ack`, `config` (retained, зберігається в NVS);
- показники: `rssi`, `uptime_s`, `chip_temp_c`, `heap_free`, `heap_min_free`;
- команди: `led` (on/off/blink), `restart`, `ota` (перевірка версії, розміру і SHA-256);
- OTA у два слоти без автоматичного відкату.

## Налаштування

```
copy main\secrets.example.h main\secrets.h
```

і заповнити `main/secrets.h` (Wi-Fi, `DM_SERVER_URL`, хост і порт MQTT, TLS, `DM_PROVISION_TOKEN`).
Файл у `.gitignore`. Тип і GPIO світлодіода — у `idf.py menuconfig` → «Модуль моніторингу (dm)»
(за замовчуванням S3: WS2812 на GPIO48, C3: звичайний на GPIO8, світиться при низькому рівні).

## Збирання

Окрема папка збирання для кожного чипа (з ESP-IDF v5.4 у PATH, тобто з «ESP-IDF PowerShell»):

```
idf.py -B build-s3 -D SDKCONFIG=build-s3/sdkconfig set-target esp32s3 build
idf.py -B build-c3 -D SDKCONFIG=build-c3/sdkconfig set-target esp32c3 build
```

Прошивання по USB (номер порту див. у диспетчері пристроїв):

```
idf.py -B build-s3 -D SDKCONFIG=build-s3/sdkconfig -p COM6 flash monitor
idf.py -B build-c3 -D SDKCONFIG=build-c3/sdkconfig -p COM5 flash monitor
```

Для OTA в інтерфейс завантажується файл `build-xx/dm_module.bin`. Версія прошивки — у `version.txt`;
перед збиранням оновлення її треба збільшити, бо модуль відхиляє ту саму версію.

## Таблиці розділів

| Чип | Файл | Слоти OTA |
|---|---|---|
| ESP32-C3, 4 МБ | `partitions_4mb.csv` | 2 × 1,875 МБ |
| ESP32-S3, 16 МБ | `partitions_16mb.csv` | 2 × 4 МБ (решта flash вільна) |

## Що перевірено на платах (2026-11-14)

Сервер з PR #1 піднято локально (`docker compose`), плати ESP32-S3 (rev v0.2) і ESP32-C3 (rev v0.4) у мережі Wi-Fi:

- реєстрація через `/api/provision`, підключення до MQTT з виданим паролем;
- `status` online (chip, fw, idf, ip, ssid, reset_reason, config_rev, led, caps), телеметрія раз на 1 с, `ts` після синхронізації SNTP;
- `config` зі зміною `interval_s` (1 → 5 → 1 с) і поверненням `config_rev` у `status`;
- команди `led` (on / blink), невідома команда і неправильний `mode` дають `error`;
- `restart`: `ok`, `offline` з `reason: "restart"`, після старту `reset_reason: "sw"`;
- `ota` через інтерфейс сервера: 0.1.0 → 0.1.1 на обох чипах, прогрес кожні 10 %, перевірка SHA-256, `reset_reason: "ota"`; повтор тієї самої версії відхиляється.

Не перевірено: запасна мережа Wi-Fi (поки не задана), Last Will при вимкненні живлення, TLS (8883), повторна реєстрація після 3 відмов брокера і відповідь 409, OTA на третій S3 і другій C3.
