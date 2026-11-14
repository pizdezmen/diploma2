# Сервер і веб-інтерфейс: запуск

Склад (усе в Docker, файл `docker-compose.yml` у корені):

| Сервіс | Що це | Порт назовні |
|---|---|---|
| `db` | PostgreSQL 16 + TimescaleDB | не публікується |
| `mqtt` | Mosquitto 2 з dynamic security (окремий логін і пароль на кожен модуль) | `MQTT_PUBLIC_PORT` (1883) |
| `server` | Python FastAPI: прийом MQTT, запис у базу, API, WebSocket | не публікується |
| `web` | Caddy: інтерфейс React і проксі `/api` на сервер; на VPS сам отримує HTTPS-сертифікат | `HTTP_PORT` (8080), `HTTPS_PORT` |

## Домашній ПК (Windows, Docker Desktop)

```
cd E:\diploma2
copy .env.example .env      (змініть паролі в .env)
docker compose up -d --build
```

- Інтерфейс: http://localhost:8080, логін і пароль з `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
- У `.env` поставте `PUBLIC_URL=http://<IP ПК у локальній мережі>:8080`, бо за цією адресою модулі завантажують прошивку.
- Для прошивки модулів: `SERVER_URL` = той самий `PUBLIC_URL`, MQTT = `<IP ПК>:1883` без TLS, `PROVISION_TOKEN` = як у `.env`.
- Брандмауер Windows має пропускати вхідні 8080 і 1883.
- Якщо порт 8080 або 1883 уже зайнятий іншою програмою, змініть `HTTP_PORT` або `MQTT_PUBLIC_PORT` у `.env` (і `PUBLIC_URL` відповідно), наприклад `HTTP_PORT=8090`.
- Якщо репозиторій клоновано до появи `.gitattributes` і брокер падає з «set: illegal option -», оновіть файли: `git rm --cached -r . -q` і `git reset --hard` (скрипти мають бути з закінченнями рядків LF).

Модуль з'являється в таблиці сам після першого підключення (реєстрація описана в `docs/PROTOCOL.md`).

## VPS

1. Доменне ім'я, що вказує на VPS.
2. У `.env`: `SITE_ADDRESS=monitor.example.com`, `HTTP_PORT=80`, `HTTPS_PORT=443`, `PUBLIC_URL=https://monitor.example.com`.
3. TLS для MQTT: отримати сертифікат (наприклад, `certbot certonly --standalone -d monitor.example.com` до запуску `web`), потім `MQTT_TLS=true`, `MQTT_PUBLIC_PORT=8883`, `MQTT_CERTS_DIR=/etc/letsencrypt/live/monitor.example.com`. Після оновлення сертифіката: `docker compose restart mqtt`.
4. `docker compose up -d --build`.

## Розробка інтерфейсу

```
cd web
npm install
npm run dev        (http://localhost:5173, запити /api ідуть на сервер на localhost:8000)
```

Сервер окремо: `cd server`, `pip install -r requirements.txt`, змінні з `.env` (`DB_DSN`, `MQTT_HOST`, `MQTT_PORT`), `uvicorn app.main:app --reload`.

## Дані

- Показники зберігаються у вузькій таблиці `telemetry (time, module_id, metric, value)`, тому нові датчики етапу 2 не потребують змін у базі.
- Середні за хвилину і за годину рахує TimescaleDB (continuous aggregates); графіки самі беруть сирі дані (до 3 год), хвилинні (до 10 днів) або годинні.
- Терміни зберігання змінюються на сторінці «Налаштування» (за замовчуванням 7 днів / 90 днів / без обмеження). Сирі дані старші за добу стискаються.
- Запис іде пачками раз на секунду.

## Що перевірено і що ні

Перевірено в Docker тестовим MQTT-клієнтом (не реальною платою): реєстрація, статус і Last Will, телеметрія, команди і відповіді, конфігурація інтервалу (модуль, група), завантаження прошивки і видача файла за токеном, групові команди, навантаження 200 модулів × 1 повідомлення/с протягом хвилини (12 000 повідомлень, 48 000 записів, без втрат).

Не перевірено: робота з реальними ESP32, OTA до кінця на платі, TLS на VPS.
