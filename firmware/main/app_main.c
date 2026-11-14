// Точка входу. Етап 1: гола плата без датчиків.
#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "nvs_flash.h"
#include "secrets.h"
#include "dm.h"

static const char *TAG = "dm";

void app_main(void)
{
    ESP_ERROR_CHECK(settings_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    device_info_init();
    status_led_init();

    ESP_LOGI(TAG, "Модуль %s, чип %s, прошивка %s, старт: %s",
             device_id(), device_chip(), device_fw_version(), device_reset_reason());

    wifi_mgr_start();

    esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(DM_SNTP_SERVER);
    esp_netif_sntp_init(&sntp_cfg);

    telemetry_start();
    mqtt_link_run(); // не повертається
}
