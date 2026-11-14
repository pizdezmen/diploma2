#include <stdio.h>
#include <string.h>
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "driver/temperature_sensor.h"
#include "sdkconfig.h"
#include "dm.h"

static const char *TAG = "device";

#define RESTART_MARK_OTA 0x4F544121u  // "OTA!"

static char s_id[13];
static const char *s_reset_reason = "other";
static temperature_sensor_handle_t s_tsens;
static esp_timer_handle_t s_restart_timer;

// Переживає програмний перезапуск, але не вимкнення живлення.
static RTC_NOINIT_ATTR uint32_t s_restart_mark;

static const char *map_reset_reason(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON:   return "poweron";
    case ESP_RST_SW:        return "sw";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:       return "wdt";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    default:                return "other";
    }
}

void device_info_init(void)
{
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(s_id, sizeof(s_id), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    esp_reset_reason_t rr = esp_reset_reason();
    s_reset_reason = map_reset_reason(rr);
    if (rr == ESP_RST_SW && s_restart_mark == RESTART_MARK_OTA) {
        s_reset_reason = "ota";
    }
    s_restart_mark = 0;

    temperature_sensor_config_t tcfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&tcfg, &s_tsens) == ESP_OK) {
        temperature_sensor_enable(s_tsens);
    } else {
        ESP_LOGW(TAG, "датчик температури чипа недоступний");
        s_tsens = NULL;
    }
}

const char *device_id(void) { return s_id; }
const char *device_chip(void) { return CONFIG_IDF_TARGET; }
const char *device_fw_version(void) { return esp_app_get_description()->version; }
const char *device_reset_reason(void) { return s_reset_reason; }

void device_mark_restart_reason_ota(void) { s_restart_mark = RESTART_MARK_OTA; }

float device_chip_temp_c(void)
{
    float t = 0;
    if (!s_tsens || temperature_sensor_get_celsius(s_tsens, &t) != ESP_OK) {
        return -273.0f;
    }
    return t;
}

static void restart_cb(void *arg) { esp_restart(); }

void device_restart_after_ms(uint32_t ms)
{
    if (!s_restart_timer) {
        const esp_timer_create_args_t a = { .callback = restart_cb, .name = "restart" };
        ESP_ERROR_CHECK(esp_timer_create(&a, &s_restart_timer));
    }
    esp_timer_stop(s_restart_timer);
    esp_timer_start_once(s_restart_timer, (uint64_t)ms * 1000);
}
