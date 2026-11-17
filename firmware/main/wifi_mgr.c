// Wi-Fi: основна мережа + запасна, перепідключення з випадковою затримкою.
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_log.h"
#include "cJSON.h"
#include "sdkconfig.h"
#include "dm_secrets.h"
#include "dm.h"

static const char *TAG = "wifi";

#define BIT_CONNECTED BIT0


static EventGroupHandle_t s_ev;
static esp_netif_t *s_netif;
static esp_timer_handle_t s_retry_timer;
static int s_net;
static int s_fails;
static int8_t s_tx_q;      // межа потужності передавача, чверті дБм; 0 = найбільша (типово)
static bool s_started;     // esp_wifi_start уже відбувся: потужність можна застосувати

#define NET(i) (netcfg()->wifi[i])

static bool net_valid(int i) { return NET(i).ssid[0] != '\0'; }

static void apply_net(int i)
{
    wifi_config_t cfg = { 0 };
    strlcpy((char *)cfg.sta.ssid, NET(i).ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, NET(i).pass, sizeof(cfg.sta.password));
    // Кілька точок доступу з однією назвою: обираємо найсильнішу.
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    cfg.sta.threshold.authmode = NET(i).pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    cfg.sta.pmf_cfg.capable = true;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
    ESP_LOGI(TAG, "мережа: %s (%s)", NET(i).ssid, i == 0 ? "основна" : "запасна");
}

static void retry_cb(void *arg) { esp_wifi_connect(); }

// Менша потужність передавача — менший піковий струм радіо (просадки живлення, PROTOCOL.md 3.5).
static void apply_tx(void)
{
    if (!s_started) return;
    esp_err_t err = esp_wifi_set_max_tx_power(s_tx_q ? s_tx_q : 84); // 84 = 21 дБм, драйвер обмежить до межі чипа
    int8_t now = 0;
    esp_wifi_get_max_tx_power(&now);
    if (err != ESP_OK) ESP_LOGW(TAG, "не вдалося задати потужність: %s", esp_err_to_name(err));
    ESP_LOGI(TAG, "потужність передавача: %.2f дБм%s", now / 4.0, s_tx_q ? "" : " (найбільша)");
}

static int8_t tx_quarters(double dbm)
{
    if (!(dbm > 0)) return 0;
    int q = (int)(dbm * 4 + 0.5);
    if (q < 8) q = 8;   // 2 дБм — найменше, що приймає драйвер
    if (q > 84) q = 0;  // понад 21 дБм — те саме, що найбільша
    return (int8_t)q;
}

void wifi_mgr_set_tx_power(double dbm)
{
    int8_t q = tx_quarters(dbm);
    if (q == s_tx_q) return;
    s_tx_q = q;
    apply_tx();
}

double wifi_mgr_tx_power(void)
{
    int8_t now = 0;
    if (!s_started || esp_wifi_get_max_tx_power(&now) != ESP_OK) return 0;
    return now / 4.0;
}

// Збережена потужність із конфігурації в NVS: застосувати ще до першого підключення.
static void load_tx_power(void)
{
    char *json = settings_get_config_json();
    if (!json) return;
    cJSON *j = cJSON_Parse(json);
    free(json);
    const cJSON *v = cJSON_GetObjectItem(j, "wifi_tx_dbm");
    if (cJSON_IsNumber(v)) s_tx_q = tx_quarters(v->valuedouble);
    cJSON_Delete(j);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        s_started = true;
        apply_tx(); // до першого підключення: саме воно дає найбільший піковий струм
#ifdef DM_DIAG_SCAN
        // Діагностика: спершу перелік видимих мереж (вмикається в secrets.h).
        wifi_scan_config_t sc = { .show_hidden = false };
        if (esp_wifi_scan_start(&sc, false) == ESP_OK) return;
#endif
        esp_wifi_connect();
#ifdef DM_DIAG_SCAN
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        uint16_t n = 20;
        static wifi_ap_record_t aps[20];
        if (esp_wifi_scan_get_ap_records(&n, aps) == ESP_OK) {
            for (int k = 0; k < n; k++) {
                ESP_LOGI(TAG, "скан: \"%s\" %d дБм, канал %d", (char *)aps[k].ssid, aps[k].rssi, aps[k].primary);
            }
        }
        if (!wifi_mgr_is_connected()) esp_wifi_connect();
#endif
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *d = data;
        xEventGroupClearBits(s_ev, BIT_CONNECTED);
        s_fails++;
        if (s_fails >= CONFIG_DM_WIFI_SWITCH_AFTER_FAILS && net_valid(1 - s_net)) {
            s_net = 1 - s_net;
            s_fails = 0;
            apply_net(s_net);
        }
        // Експоненційна затримка до ~30 с плюс випадкові 0–2 с,
        // щоб 200 модулів не підключалися одночасно.
        int shift = s_fails > 5 ? 5 : s_fails;
        uint32_t delay_ms = (1000u << shift);
        if (delay_ms > 30000) delay_ms = 30000;
        delay_ms += esp_random() % 2000;
        ESP_LOGW(TAG, "відключено (причина %d), повтор через %lu мс", d->reason, (unsigned long)delay_ms);
        esp_timer_stop(s_retry_timer);
        esp_timer_start_once(s_retry_timer, (uint64_t)delay_ms * 1000);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "IP " IPSTR, IP2STR(&e->ip_info.ip));
        s_fails = 0;
        xEventGroupSetBits(s_ev, BIT_CONNECTED);
    }
}

void wifi_mgr_start(void)
{
    s_ev = xEventGroupCreate();
    s_netif = esp_netif_create_default_wifi_sta();
    char host[32];
    snprintf(host, sizeof(host), "dm-%s", device_id());
    esp_netif_set_hostname(s_netif, host);

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

    const esp_timer_create_args_t ta = { .callback = retry_cb, .name = "wifi_retry" };
    ESP_ERROR_CHECK(esp_timer_create(&ta, &s_retry_timer));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    if (!net_valid(0)) {
        ESP_LOGW(TAG, "мережу не задано: модуль чекає налаштувань через USB");
        return;
    }
    load_tx_power();
    s_net = 0;
    apply_net(s_net);
    ESP_ERROR_CHECK(esp_wifi_start());
}

bool wifi_mgr_wait_connected(uint32_t timeout_ms)
{
    return xEventGroupWaitBits(s_ev, BIT_CONNECTED, pdFALSE, pdTRUE,
                               timeout_ms == UINT32_MAX ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms))
           & BIT_CONNECTED;
}

bool wifi_mgr_is_connected(void) { return xEventGroupGetBits(s_ev) & BIT_CONNECTED; }

int wifi_mgr_rssi(void)
{
    wifi_ap_record_t ap;
    if (!wifi_mgr_is_connected() || esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return 0;
    return ap.rssi;
}

void wifi_mgr_ip(char *buf, size_t len)
{
    esp_netif_ip_info_t ip;
    if (esp_netif_get_ip_info(s_netif, &ip) == ESP_OK) {
        snprintf(buf, len, IPSTR, IP2STR(&ip.ip));
    } else {
        buf[0] = '\0';
    }
}

const char *wifi_mgr_ssid(void) { return NET(s_net).ssid; }
