// Реєстрація модуля на сервері: POST <SERVER_URL>/api/provision (PROTOCOL.md 2).
#include <string.h>
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "cJSON.h"
#include "secrets.h"
#include "dm.h"

static const char *TAG = "provision";

provision_result_t provision_request(char *pass_out, size_t len)
{
    char url[160];
    snprintf(url, sizeof(url), "%s/api/provision", DM_SERVER_URL);

    cJSON *req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "id", device_id());
    cJSON_AddStringToObject(req, "chip", device_chip());
    cJSON_AddStringToObject(req, "fw", device_fw_version());
    cJSON_AddStringToObject(req, "token", DM_PROVISION_TOKEN);
    char *body = cJSON_PrintUnformatted(req);
    cJSON_Delete(req);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        .crt_bundle_attach = strncmp(url, "https", 5) == 0 ? esp_crt_bundle_attach : NULL,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    esp_http_client_set_header(c, "Content-Type", "application/json");

    provision_result_t res = PROVISION_FAILED;
    char resp[256] = { 0 };
    int blen = strlen(body);

    if (esp_http_client_open(c, blen) != ESP_OK) {
        ESP_LOGW(TAG, "не вдалося з'єднатися з %s", url);
        goto out;
    }
    if (esp_http_client_write(c, body, blen) != blen) goto out;
    esp_http_client_fetch_headers(c);
    int status = esp_http_client_get_status_code(c);
    int n = esp_http_client_read_response(c, resp, sizeof(resp) - 1);
    if (n > 0) resp[n] = '\0';

    if (status == 200) {
        cJSON *j = cJSON_Parse(resp);
        const cJSON *p = cJSON_GetObjectItem(j, "password");
        if (cJSON_IsString(p) && p->valuestring[0] && strlen(p->valuestring) < len) {
            strlcpy(pass_out, p->valuestring, len);
            res = PROVISION_OK;
            ESP_LOGI(TAG, "модуль зареєстровано");
        } else {
            ESP_LOGW(TAG, "відповідь 200 без пароля");
        }
        cJSON_Delete(j);
    } else if (status == 401) {
        res = PROVISION_BAD_TOKEN;
        ESP_LOGE(TAG, "сервер відхилив токен реєстрації (401)");
    } else if (status == 409) {
        res = PROVISION_CONFLICT;
        ESP_LOGW(TAG, "модуль уже зареєстровано (409): скиньте пароль MQTT в інтерфейсі");
    } else {
        ESP_LOGW(TAG, "неочікувана відповідь %d", status);
    }

out:
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    cJSON_free(body);
    return res;
}
