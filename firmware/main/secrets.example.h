// Скопіюйте цей файл у secrets.h і заповніть. secrets.h не потрапляє в git.
#pragma once

// Основна мережа (одна назва на всі точки доступу) і запасна
#define DM_WIFI_PRIMARY_SSID   "MyWiFi"
#define DM_WIFI_PRIMARY_PASS   "password"
#define DM_WIFI_BACKUP_SSID    ""          // порожньо = запасної мережі немає
#define DM_WIFI_BACKUP_PASS    ""

// Адреса HTTP API сервера (реєстрація модуля), без "/" в кінці
#define DM_SERVER_URL          "http://192.168.1.10:8080"

// MQTT-брокер
#define DM_MQTT_HOST           "192.168.1.10"
#define DM_MQTT_PORT           1883        // 8883 з TLS
#define DM_MQTT_TLS            0           // 1 = mqtts, перевірка сертифіката через esp_crt_bundle

// Токен реєстрації, той самий, що PROVISION_TOKEN у .env сервера
#define DM_PROVISION_TOKEN     "change-me-provision"

// Сервер часу (SNTP)
#define DM_SNTP_SERVER         "pool.ntp.org"
