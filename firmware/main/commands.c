// Команди від сервера (PROTOCOL.md 3.3) і відповіді на них (3.4).
#include <string.h>
#include "esp_log.h"
#include "cJSON.h"
#include "dm.h"

static const char *TAG = "cmd";

void commands_ack(const char *id, const char *status, int progress, const char *message)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "id", id);
    cJSON_AddStringToObject(j, "status", status);
    if (progress >= 0) cJSON_AddNumberToObject(j, "progress", progress);
    cJSON_AddStringToObject(j, "message", message ? message : "");
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    mqtt_link_publish("cmd/ack", s, 1, false);
    cJSON_free(s);
}

static const char *str_param(const cJSON *params, const char *key)
{
    const cJSON *v = cJSON_GetObjectItem(params, key);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

static void cmd_led(const char *id, const cJSON *params)
{
    const char *mode = str_param(params, "mode");
    led_mode_t m;
    if (mode && strcmp(mode, "on") == 0) m = LED_ON;
    else if (mode && strcmp(mode, "off") == 0) m = LED_OFF;
    else if (mode && strcmp(mode, "blink") == 0) m = LED_BLINK;
    else {
        commands_ack(id, "error", -1, "mode must be on|off|blink");
        return;
    }
    status_led_set(m);
    commands_ack(id, "ok", -1, NULL);
    mqtt_link_publish_status();
}

static void cmd_restart(const char *id)
{
    commands_ack(id, "ok", -1, NULL);
    mqtt_link_publish_offline("restart");
    device_restart_after_ms(500);
}

static void cmd_ota(const char *id, const cJSON *params)
{
    ota_request_t req = { 0 };
    const char *url = str_param(params, "url");
    const char *ver = str_param(params, "version");
    const char *sha = str_param(params, "sha256");
    const cJSON *size = cJSON_GetObjectItem(params, "size");

    if (!url || strlen(url) >= sizeof(req.url)) {
        commands_ack(id, "error", -1, "missing or too long url");
        return;
    }
    if (sha && strlen(sha) != 64) {
        commands_ack(id, "error", -1, "sha256 must be 64 hex chars");
        return;
    }
    if (ver && strcmp(ver, device_fw_version()) == 0) {
        commands_ack(id, "error", -1, "this version is already running");
        return;
    }
    strlcpy(req.id, id, sizeof(req.id));
    strlcpy(req.url, url, sizeof(req.url));
    if (ver) strlcpy(req.version, ver, sizeof(req.version));
    if (sha) strlcpy(req.sha256, sha, sizeof(req.sha256));
    if (cJSON_IsNumber(size) && size->valuedouble > 0) req.size = (uint32_t)size->valuedouble;

    esp_err_t err = ota_start(&req);
    if (err == ESP_ERR_INVALID_STATE) {
        commands_ack(id, "error", -1, "ota already in progress");
    } else if (err != ESP_OK) {
        commands_ack(id, "error", -1, "cannot start ota task");
    }
    // Далі відповідає задача OTA: in_progress … ok / error.
}

void commands_handle(const char *data, int len)
{
    cJSON *j = cJSON_ParseWithLength(data, len);
    if (!j) {
        ESP_LOGW(TAG, "команда не JSON");
        return;
    }
    const cJSON *idj = cJSON_GetObjectItem(j, "id");
    const cJSON *namej = cJSON_GetObjectItem(j, "name");
    const cJSON *params = cJSON_GetObjectItem(j, "params");

    if (!cJSON_IsString(idj) || strlen(idj->valuestring) > 36) {
        ESP_LOGW(TAG, "команда без коректного id");
        cJSON_Delete(j);
        return;
    }
    const char *id = idj->valuestring;
    const char *name = cJSON_IsString(namej) ? namej->valuestring : "";
    ESP_LOGI(TAG, "команда %s (%s)", name, id);

    if (strcmp(name, "led") == 0) cmd_led(id, params);
    else if (strcmp(name, "restart") == 0) cmd_restart(id);
    else if (strcmp(name, "ota") == 0) cmd_ota(id, params);
    else commands_ack(id, "error", -1, "unknown command");

    cJSON_Delete(j);
}
