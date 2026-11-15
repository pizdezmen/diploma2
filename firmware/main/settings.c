// Збереження у NVS, простір "dm" (PROTOCOL.md 2 і 3.5).
#include <stdlib.h>
#include <string.h>
#include "nvs_flash.h"
#include "nvs.h"
#include "dm.h"

#define NS "dm"

esp_err_t settings_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

bool settings_get_mqtt_pass(char *buf, size_t len)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;
    size_t l = len;
    esp_err_t err = nvs_get_str(h, "mqtt_pass", buf, &l);
    nvs_close(h);
    return err == ESP_OK && buf[0] != '\0';
}

static esp_err_t write_str(const char *key, const char *val)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = val ? nvs_set_str(h, key, val) : nvs_erase_key(h, key);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t settings_set_mqtt_pass(const char *pass) { return write_str("mqtt_pass", pass); }
esp_err_t settings_erase_mqtt_pass(void) { return write_str("mqtt_pass", NULL); }

void settings_get_config(uint32_t *rev, uint32_t *interval_s)
{
    *rev = 0;
    *interval_s = 1;
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return;
    nvs_get_u32(h, "cfg_rev", rev);
    nvs_get_u32(h, "cfg_interval", interval_s);
    nvs_close(h);
}

// Уся конфігурація з теми config (етап 2) зберігається як рядок JSON.
char *settings_get_config_json(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return NULL;
    size_t len = 0;
    char *buf = NULL;
    if (nvs_get_str(h, "cfg_json", NULL, &len) == ESP_OK && len > 1) {
        buf = malloc(len);
        if (buf && nvs_get_str(h, "cfg_json", buf, &len) != ESP_OK) {
            free(buf);
            buf = NULL;
        }
    }
    nvs_close(h);
    return buf;
}

esp_err_t settings_set_config_json(const char *json) { return write_str("cfg_json", json); }
