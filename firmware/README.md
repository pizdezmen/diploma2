# Прошивка модуля

ESP-IDF, одна кодова база для ESP32-S3 (16 МБ flash, 8 МБ PSRAM) і ESP32-C3 (4 МБ flash).
Протокол обміну з сервером: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

Що вміє етап 1 (гола плата без датчиків):

- підключення до вшитої Wi-Fi мережі (основна + запасна), вибір найсильнішої точки доступу з однією назвою, перепідключення з випадковою затримкою;
- самореєстрація на сервері (`POST /api/provision`), пароль MQTT зберігається в NVS;
- MQTT: `status` (retained, Last Will `offline`), `telemetry` раз на `interval_s` (за замовчуванням 1 с), `cmd` / `cmd/ack`, `config` (retained, зберігається в NVS);
- показники: `rssi`, `uptime_s`, `chip_temp_c`, `heap_free`, `heap_min_free`;
- команди: `led` (on/off/blink), `restart`, `ota` (перевірка версії, розміру і SHA-256);
- OTA у два слоти без автоматичного відкату.

З версії 0.3.0 (частина етапу 2, `telemetry.c`, `signal.c`): вимір щосекунди, фільтр на модулі (ковзне середнє, медіана,
експоненційний), межі норми з гістерезисом, гібридний режим надсилання і передісторія тривоги (PROTOCOL.md 3.5–3.6).
Налаштування задаються на сторінці модуля в розділі «Обробка на модулі».

## Налаштування

Основний спосіб — з сайту (сторінка «Додати модуль», PROTOCOL.md розділ 6): сайт прошиває повний образ
і передає через USB назви й паролі Wi-Fi, адресу сервера, брокер MQTT і токен. Модуль зберігає їх у NVS.
Поки налаштувань немає, світлодіод блимає, а модуль чекає команд на USB-порту.

Для розробки можна задати ті самі значення у файлі (налаштування з NVS мають пріоритет):

```
copy main\secrets.example.h main\secrets.h
```

і заповнити `main/secrets.h` (Wi-Fi, `DM_SERVER_URL`, хост і порт MQTT, TLS, `DM_PROVISION_TOKEN`).
Файл у `.gitignore`. Тип і GPIO світлодіода — у `idf.py menuconfig` → «Модуль моніторингу (dm)»
(за замовчуванням S3: WS2812 на GPIO48, C3: звичайний на GPIO8, світиться при низькому рівні).

## Екран (доповнення)

Екран OLED 0,96″ 128×64 з чотирма контактами (GND, VCC, SCL, SDA), контролер SSD1306 або SSD1315. Підключення:

| Контакт екрана | ESP32-S3 (DevKitC-1) | ESP32-C3 (SuperMini) |
|---|---|---|
| GND | GND | GND |
| VCC | 3V3 | 3V3 |
| SCL | GPIO9 | GPIO6 |
| SDA | GPIO8 | GPIO5 |

Далі на сайті: сторінка модуля → «Доповнення» → «Додати екран», вибрати, що показувати, і зберегти. Виводи можна змінити там само. Кнопка BOOT на платі будить погашений екран і гортає сторінки. Код: `main/addons/` (ядро доповнень і шина I2C) і `main/addons/display/` (екран, шрифти). Шрифти генерує `tools/gen_font.py` зі шрифтів Misc Fixed (суспільне надбання).

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

Повні образи для сайту (без значень із `secrets.h`, запис з адреси 0):

```
idf.py -B build-site-s3 -D SDKCONFIG=build-site-s3/sdkconfig -D DM_NO_SECRETS=1 set-target esp32s3 build
idf.py -B build-site-s3 -D SDKCONFIG=build-site-s3/sdkconfig -D DM_NO_SECRETS=1 merge-bin -o dm_full_s3.bin
```

(для C3 так само з `c3` / `esp32c3`). Файл з'являється в `build-site-s3/dm_full_s3.bin`.

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
