// Точка входу: показники самої плати, обробка на модулі, доповнення (екрани).
#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "nvs_flash.h"
#include "dm.h"
#include "addons.h"

static const char *TAG = "dm";

void app_main(void)
{
    ESP_ERROR_CHECK(settings_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    device_info_init();
    status_led_init();
    netcfg_load();
    serial_cfg_start();

    ESP_LOGI(TAG, "Модуль %s, чип %s, прошивка %s, старт: %s",
             device_id(), device_chip(), device_fw_version(), device_reset_reason());

    if (!netcfg_usable()) {
        status_led_set(LED_BLINK); // ознака: модуль ще не налаштовано
    }
    wifi_mgr_start();

    esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_netif_sntp_init(&sntp_cfg);

    addons_init();   // до telemetry_start: та застосовує збережену конфігурацію доповнень
    telemetry_start();
    mqtt_link_run(); // не повертається
}
