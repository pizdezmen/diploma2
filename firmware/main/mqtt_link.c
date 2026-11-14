// Зв'язок із сервером: реєстрація, MQTT-клієнт, розбір вхідних тем (PROTOCOL.md 2–3).
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "mqtt_client.h"
#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "esp_log.h"
#include "esp_idf_version.h"
#include "cJSON.h"
#include "secrets.h"
#include "dm.h"

static const char *TAG = "mqtt";

#define BIT_REPROVISION BIT0
#define AUTH_FAILS_LIMIT 3

static esp_mqtt_client_handle_t s_client;
static SemaphoreHandle_t s_lock;
static EventGroupHandle_t s_ev;
static volatile bool s_connected;
static int s_auth_fails;
static char s_pass[80];
static char s_topic_cmd[48];
static char s_topic_config[48];
static char s_topic_status[48];

static void topic(char *buf, size_t len, const char *suffix)
{
    snprintf(buf, len, "dm/v1/%s/%s", device_id(), suffix);
}

bool mqtt_link_connected(void) { return s_connected; }

int mqtt_link_publish(const char *suffix, const char *data, int qos, bool retain)
{
    char t[48];
    topic(t, sizeof(t), suffix);
    int r = -1;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_client && s_connected) {
        r = esp_mqtt_client_publish(s_client, t, data, 0, qos, retain);
    }
    xSemaphoreGive(s_lock);
    return r;
}

void mqtt_link_publish_status(void)
{
    char ip[16];
    wifi_mgr_ip(ip, sizeof(ip));

    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "state", "online");
    cJSON_AddStringToObject(j, "chip", device_chip());
    cJSON_AddStringToObject(j, "fw", device_fw_version());
    cJSON_AddStringToObject(j, "idf", esp_get_idf_version());
    cJSON_AddStringToObject(j, "ip", ip);
    cJSON_AddStringToObject(j, "ssid", wifi_mgr_ssid());
    cJSON_AddStringToObject(j, "reset_reason", device_reset_reason());
    cJSON_AddNumberToObject(j, "config_rev", telemetry_config_rev());
    cJSON_AddStringToObject(j, "led", status_led_mode_str());
    const char *caps[] = { "led", "restart", "ota" };
    cJSON_AddItemToObject(j, "caps", cJSON_CreateStringArray(caps, 3));
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    mqtt_link_publish("status", s, 1, true);
    cJSON_free(s);
}

void mqtt_link_publish_offline(const char *reason)
{
    char s[64];
    snprintf(s, sizeof(s), "{\"state\":\"offline\",\"reason\":\"%s\"}", reason);
    mqtt_link_publish("status", s, 1, true);
}

static bool topic_is(const esp_mqtt_event_t *e, const char *t)
{
    return e->topic_len == (int)strlen(t) && memcmp(e->topic, t, e->topic_len) == 0;
}

static void on_mqtt(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_mqtt_event_handle_t e = data;
    switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
        ESP_LOGI(TAG, "підключено до брокера");
        s_auth_fails = 0;
        s_connected = true;
        esp_mqtt_client_subscribe(e->client, s_topic_cmd, 1);
        esp_mqtt_client_subscribe(e->client, s_topic_config, 1);
        mqtt_link_publish_status();
        break;
    case MQTT_EVENT_DISCONNECTED:
        if (s_connected) ESP_LOGW(TAG, "з'єднання з брокером втрачено");
        s_connected = false;
        break;
    case MQTT_EVENT_ERROR:
        if (e->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            esp_mqtt_connect_return_code_t rc = e->error_handle->connect_return_code;
            ESP_LOGW(TAG, "брокер відхилив підключення, код %d", rc);
            if (rc == MQTT_CONNECTION_REFUSE_BAD_USERNAME ||
                rc == MQTT_CONNECTION_REFUSE_NOT_AUTHORIZED) {
                if (++s_auth_fails >= AUTH_FAILS_LIMIT) {
                    xEventGroupSetBits(s_ev, BIT_REPROVISION);
                }
            }
        }
        break;
    case MQTT_EVENT_DATA:
        if (e->data_len != e->total_data_len) {
            ESP_LOGW(TAG, "завелике повідомлення (%d байт), пропущено", e->total_data_len);
            break;
        }
        if (topic_is(e, s_topic_cmd)) {
            commands_handle(e->data, e->data_len);
        } else if (topic_is(e, s_topic_config)) {
            telemetry_apply_config(e->data, e->data_len);
        }
        break;
    default:
        break;
    }
}

static void client_start(void)
{
    static char uri[96];
    snprintf(uri, sizeof(uri), "%s://%s:%d", DM_MQTT_TLS ? "mqtts" : "mqtt", DM_MQTT_HOST, DM_MQTT_PORT);

    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = uri,
        .broker.verification.crt_bundle_attach = DM_MQTT_TLS ? esp_crt_bundle_attach : NULL,
        .credentials.client_id = device_id(),
        .credentials.username = device_id(),
        .credentials.authentication.password = s_pass,
        .session.keepalive = 30,
        .session.disable_clean_session = false,
        .session.last_will = {
            .topic = s_topic_status,
            .msg = "{\"state\":\"offline\"}",
            .qos = 1,
            .retain = 1,
        },
        // Випадкова затримка перепідключення, щоб модулі не ломилися одночасно.
        .network.reconnect_timeout_ms = 5000 + esp_random() % 5000,
        .buffer.size = 2048,
    };
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_client = esp_mqtt_client_init(&cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, on_mqtt, NULL);
    esp_mqtt_client_start(s_client);
    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "брокер %s", uri);
}

static void client_stop(void)
{
    // Зупиняємо поза блокуванням: обробник подій теж бере s_lock.
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_mqtt_client_handle_t c = s_client;
    s_client = NULL;
    s_connected = false;
    xSemaphoreGive(s_lock);
    if (c) {
        esp_mqtt_client_stop(c);
        esp_mqtt_client_destroy(c);
    }
}

void mqtt_link_run(void)
{
    s_lock = xSemaphoreCreateMutex();
    s_ev = xEventGroupCreate();
    topic(s_topic_cmd, sizeof(s_topic_cmd), "cmd");
    topic(s_topic_config, sizeof(s_topic_config), "config");
    topic(s_topic_status, sizeof(s_topic_status), "status");

    for (;;) {
        wifi_mgr_wait_connected(UINT32_MAX);

        if (!settings_get_mqtt_pass(s_pass, sizeof(s_pass))) {
            uint32_t wait_ms;
            switch (provision_request(s_pass, sizeof(s_pass))) {
            case PROVISION_OK:
                settings_set_mqtt_pass(s_pass);
                wait_ms = 0;
                break;
            case PROVISION_BAD_TOKEN: wait_ms = 5 * 60 * 1000; break;
            case PROVISION_CONFLICT:  wait_ms = 60 * 1000; break;
            default:                  wait_ms = 10000 + esp_random() % 10000; break;
            }
            if (wait_ms) {
                vTaskDelay(pdMS_TO_TICKS(wait_ms));
                continue;
            }
        }

        s_auth_fails = 0;
        xEventGroupClearBits(s_ev, BIT_REPROVISION);
        client_start();

        // Клієнт сам перепідключається; повертаємося сюди лише коли пароль став недійсним.
        xEventGroupWaitBits(s_ev, BIT_REPROVISION, pdTRUE, pdTRUE, portMAX_DELAY);
        ESP_LOGW(TAG, "брокер %d рази відхилив пароль: повторна реєстрація", AUTH_FAILS_LIMIT);
        client_stop();
        settings_erase_mqtt_pass();
        s_pass[0] = '\0';
    }
}
