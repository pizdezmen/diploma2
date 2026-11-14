// Власні показники плати (PROTOCOL.md 3.2) і конфігурація інтервалу (3.5).
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_log.h"
#include "cJSON.h"
#include "dm.h"

static const char *TAG = "telemetry";

#define INTERVAL_MIN_S 1
#define INTERVAL_MAX_S 3600

static TaskHandle_t s_task;
static volatile uint32_t s_interval_s = 1;
static volatile uint32_t s_config_rev;
static uint32_t s_seq;

uint32_t telemetry_config_rev(void) { return s_config_rev; }

static int64_t now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    if (tv.tv_sec < 1700000000) return 0; // SNTP ще не синхронізувався
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static void publish_once(void)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddNumberToObject(j, "ts", (double)now_ms());
    cJSON_AddNumberToObject(j, "seq", s_seq++);
    cJSON *v = cJSON_AddObjectToObject(j, "values");
    cJSON_AddNumberToObject(v, "rssi", wifi_mgr_rssi());
    cJSON_AddNumberToObject(v, "uptime_s", (double)(esp_timer_get_time() / 1000000));
    float t = device_chip_temp_c();
    if (t > -273.0f) {
        cJSON_AddNumberToObject(v, "chip_temp_c", (int)(t * 10 + (t >= 0 ? 0.5f : -0.5f)) / 10.0);
    }
    cJSON_AddNumberToObject(v, "heap_free", esp_get_free_heap_size());
    cJSON_AddNumberToObject(v, "heap_min_free", esp_get_minimum_free_heap_size());
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    mqtt_link_publish("telemetry", s, 0, false);
    cJSON_free(s);
}

static void task(void *arg)
{
    TickType_t next = xTaskGetTickCount();
    for (;;) {
        if (mqtt_link_connected()) {
            publish_once();
        }
        next += pdMS_TO_TICKS(s_interval_s * 1000);
        TickType_t now = xTaskGetTickCount();
        if ((int32_t)(next - now) <= 0) next = now + 1;
        // Сповіщення від telemetry_apply_config перериває очікування.
        if (ulTaskNotifyTake(pdTRUE, next - now)) {
            next = xTaskGetTickCount();
        }
    }
}

void telemetry_start(void)
{
    uint32_t rev, interval;
    settings_get_config(&rev, &interval);
    if (interval < INTERVAL_MIN_S || interval > INTERVAL_MAX_S) interval = 1;
    s_config_rev = rev;
    s_interval_s = interval;
    ESP_LOGI(TAG, "конфігурація з NVS: rev %lu, інтервал %lu с", (unsigned long)rev, (unsigned long)interval);
    xTaskCreate(task, "telemetry", 4096, NULL, 5, &s_task);
}

void telemetry_apply_config(const char *data, int len)
{
    cJSON *j = cJSON_ParseWithLength(data, len);
    if (!j) {
        ESP_LOGW(TAG, "config: не JSON");
        return;
    }
    uint32_t rev = s_config_rev, interval = s_interval_s;
    const cJSON *r = cJSON_GetObjectItem(j, "rev");
    const cJSON *i = cJSON_GetObjectItem(j, "interval_s");
    if (cJSON_IsNumber(r) && r->valuedouble >= 0) rev = (uint32_t)r->valuedouble;
    if (cJSON_IsNumber(i)) {
        int v = (int)i->valuedouble;
        if (v < INTERVAL_MIN_S) v = INTERVAL_MIN_S;
        if (v > INTERVAL_MAX_S) v = INTERVAL_MAX_S;
        interval = v;
    }
    cJSON_Delete(j);

    if (rev == s_config_rev && interval == s_interval_s) {
        return; // нічого не змінилося (retained config після перепідключення)
    }
    s_config_rev = rev;
    s_interval_s = interval;
    settings_set_config(rev, interval);
    ESP_LOGI(TAG, "нова конфігурація: rev %lu, інтервал %lu с", (unsigned long)rev, (unsigned long)interval);
    xTaskNotifyGive(s_task);
    mqtt_link_publish_status();
}
