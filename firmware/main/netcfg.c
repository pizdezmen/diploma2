// Мережеві налаштування модуля: NVS (з сайту через USB) мають пріоритет над secrets.h.
#include <string.h>
#include "nvs.h"
#include "esp_log.h"
#include "dm_secrets.h"
#include "dm.h"

static const char *TAG = "netcfg";

#define NS "dm"
#define KEY "netcfg"
#define NETCFG_VERSION 1

typedef struct {
    uint8_t version;
    dm_netcfg_t cfg;
} stored_t;

static dm_netcfg_t s_cfg;
static bool s_from_nvs;

static void load_secrets(dm_netcfg_t *c)
{
    memset(c, 0, sizeof(*c));
#ifdef DM_HAVE_SECRETS
    strlcpy(c->wifi[0].ssid, DM_WIFI_PRIMARY_SSID, sizeof(c->wifi[0].ssid));
    strlcpy(c->wifi[0].pass, DM_WIFI_PRIMARY_PASS, sizeof(c->wifi[0].pass));
    strlcpy(c->wifi[1].ssid, DM_WIFI_BACKUP_SSID, sizeof(c->wifi[1].ssid));
    strlcpy(c->wifi[1].pass, DM_WIFI_BACKUP_PASS, sizeof(c->wifi[1].pass));
    strlcpy(c->server_url, DM_SERVER_URL, sizeof(c->server_url));
    strlcpy(c->mqtt_host, DM_MQTT_HOST, sizeof(c->mqtt_host));
    c->mqtt_port = DM_MQTT_PORT;
    c->mqtt_tls = DM_MQTT_TLS;
    strlcpy(c->token, DM_PROVISION_TOKEN, sizeof(c->token));
#endif
}

void netcfg_load(void)
{
    stored_t st;
    size_t len = sizeof(st);
    nvs_handle_t h;
    s_from_nvs = false;
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        if (nvs_get_blob(h, KEY, &st, &len) == ESP_OK && len == sizeof(st) && st.version == NETCFG_VERSION) {
            s_cfg = st.cfg;
            s_from_nvs = true;
        }
        nvs_close(h);
    }
    if (!s_from_nvs) load_secrets(&s_cfg);
    ESP_LOGI(TAG, "налаштування: %s", s_from_nvs ? "з NVS" : (netcfg_usable() ? "з secrets.h" : "немає, чекаю через USB"));
}

const dm_netcfg_t *netcfg(void) { return &s_cfg; }
bool netcfg_configured(void) { return s_from_nvs; }

bool netcfg_usable(void)
{
    return s_cfg.wifi[0].ssid[0] && s_cfg.server_url[0] && s_cfg.mqtt_host[0] && s_cfg.mqtt_port;
}

esp_err_t netcfg_save(const dm_netcfg_t *c)
{
    stored_t st = { .version = NETCFG_VERSION, .cfg = *c };
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, KEY, &st, sizeof(st));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}
