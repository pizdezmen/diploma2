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
#include "dm.h"
#include "addons.h"

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
    // s_lock тримаємо лише для читання вказівника: під час обробки подій клієнт
    // тримає власне блокування, і вкладене очікування призвело б до взаємоблокування.
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_mqtt_client_handle_t c = s_connected ? s_client : NULL;
    xSemaphoreGive(s_lock);
    return c ? esp_mqtt_client_publish(c, t, data, 0, qos, retain) : -1;
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
    double tx = wifi_mgr_tx_power();
    if (tx > 0) cJSON_AddNumberToObject(j, "wifi_tx_dbm", tx);
    const char *caps[] = { "led", "restart", "ota", "filters", "limits", "hybrid", "wifi_tx" };
    cJSON *ca = cJSON_CreateStringArray(caps, sizeof(caps) / sizeof(caps[0]));
    addons_add_caps(ca);
    cJSON_AddItemToObject(j, "caps", ca);
    addons_add_status(j);
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    mqtt_link_publish("status", s, 1, true);
    cJSON_free(s);
}

static char s_offline_reason[16];
static volatile int s_offline_msg_id = -1;

#define BIT_OFFLINE_ACKED BIT1

// Окрема задача: із задачі MQTT-клієнта не можна викликати esp_mqtt_client_stop.
static void offline_task(void *arg)
{
    char s[64];
    snprintf(s, sizeof(s), "{\"state\":\"offline\",\"reason\":\"%s\"}", s_offline_reason);
    s_offline_msg_id = mqtt_link_publish("status", s, 1, true);
    // Чекаємо PUBACK, щоб у сокеті не лишилося непрочитаних даних: інакше закриття
    // з'єднання йде як RST, брокер губить DISCONNECT і публікує Last Will без reason.
    if (s_offline_msg_id > 0) {
        xEventGroupWaitBits(s_ev, BIT_OFFLINE_ACKED, pdTRUE, pdTRUE, pdMS_TO_TICKS(2000));
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_mqtt_client_handle_t c = s_client;
    s_connected = false;
    xSemaphoreGive(s_lock);
    if (c) esp_mqtt_client_stop(c); // надсилає DISCONNECT, Last Will не спрацьовує
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
}

void mqtt_link_offline_and_restart(const char *reason)
{
    strlcpy(s_offline_reason, reason, sizeof(s_offline_reason));
    device_restart_after_ms(5000); // запасний варіант, якщо щось зависне
    if (xTaskCreate(offline_task, "offline", 3072, NULL, 5, NULL) != pdPASS) {
        device_restart_after_ms(500);
    }
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
    case MQTT_EVENT_PUBLISHED:
        if (e->msg_id == s_offline_msg_id) xEventGroupSetBits(s_ev, BIT_OFFLINE_ACKED);
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
    const dm_netcfg_t *nc = netcfg();
    static char uri[128];
    snprintf(uri, sizeof(uri), "%s://%s:%u", nc->mqtt_tls ? "mqtts" : "mqtt", nc->mqtt_host, nc->mqtt_port);

    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = uri,
        .broker.verification.crt_bundle_attach = nc->mqtt_tls ? esp_crt_bundle_attach : NULL,
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
        .buffer.size = 4096, // вхідна конфігурація з доповненнями (PROTOCOL.md 3.7, до ~3,8 КБ)
        .buffer.out_size = 12288, // телеметрія з передісторією тривоги (telemetry.c, MSG_MAX_LEN)
    };
    esp_mqtt_client_handle_t c = esp_mqtt_client_init(&cfg);
    esp_mqtt_client_register_event(c, ESP_EVENT_ANY_ID, on_mqtt, NULL);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_client = c;
    xSemaphoreGive(s_lock);
    esp_mqtt_client_start(c);
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
        vTaskDelay(pdMS_TO_TICKS(500)); // дати завершитися публікаціям, що вже взяли вказівник
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
