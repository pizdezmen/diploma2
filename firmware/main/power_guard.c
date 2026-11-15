// Захист від одночасного ввімкнення багатьох плат від одного блока живлення.
//
// 1. Апаратний сторож (RTC WDT): якщо після просадки живлення плата зависне цілком
//    (стоять усі задачі, зокрема сторож задач), вона сама повністю перезапуститься.
// 2. Випадкова пауза 0–5 с перед увімкненням Wi-Fi після ввімкнення живлення, щоб пікові
//    струми радіо різних плат не збігалися в часі.
// Поріг детектора просадки (brownout) піднято в sdkconfig.defaults: плата перезапускається
// раніше, ніж напруга опуститься до рівня, на якому flash і процесор працюють ненадійно.
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_random.h"
#include "esp_mac.h"
#include "bootloader_random.h"
#include "hal/wdt_hal.h"
#include "soc/rtc.h"
#include "dm.h"

static const char *TAG = "power";

#define RTC_WDT_TIMEOUT_MS 10000  // без годування стільки — повний перезапуск
#define RTC_WDT_FEED_MS    1000
#define START_DELAY_MAX_MS 5000   // пауза перед Wi-Fi після ввімкнення живлення
#define BROWNOUT_EXTRA_MS  1000   // після просадки ще трохи довше: хай живлення відновиться

static wdt_hal_context_t s_rwdt = RWDT_HAL_CONTEXT_DEFAULT();
static uint32_t s_rand;

static void feed_task(void *arg)
{
    for (;;) {
        wdt_hal_write_protect_disable(&s_rwdt);
        wdt_hal_feed(&s_rwdt);
        wdt_hal_write_protect_enable(&s_rwdt);
        vTaskDelay(pdMS_TO_TICKS(RTC_WDT_FEED_MS));
    }
}

static uint32_t random_seed(void)
{
    // Викликається першим, доки АЦП ще не зайнятий (його ж використовує джерело ентропії).
    // До старту радіо esp_random() дає лише псевдовипадкові числа, однакові на всіх платах.
    // Тимчасово вмикаємо джерело ентропії і додаємо MAC, щоб паузи точно відрізнялися.
    bootloader_random_enable();
    uint32_t r = esp_random();
    bootloader_random_disable();
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    uint32_t h = 2166136261u; // FNV-1a
    for (int i = 0; i < 6; i++) h = (h ^ mac[i]) * 16777619u;
    return r ^ h;
}

void power_guard_start(void)
{
    s_rand = random_seed();
    uint32_t ticks = (uint32_t)((uint64_t)RTC_WDT_TIMEOUT_MS * rtc_clk_slow_freq_get_hz() / 1000);
    wdt_hal_init(&s_rwdt, WDT_RWDT, 0, false);
    wdt_hal_write_protect_disable(&s_rwdt);
    wdt_hal_config_stage(&s_rwdt, WDT_STAGE0, ticks, WDT_STAGE_ACTION_RESET_RTC);
    wdt_hal_enable(&s_rwdt);
    wdt_hal_feed(&s_rwdt);
    wdt_hal_write_protect_enable(&s_rwdt);
    // Високий пріоритет: годування не має пропускатися через зайняті задачі;
    // зависання окремої задачі ловить сторож задач (addons.c), а цей — зависання всієї плати.
    xTaskCreate(feed_task, "rwdt_feed", 2048, NULL, configMAX_PRIORITIES - 2, NULL);
}

void power_guard_start_delay(void)
{
    esp_reset_reason_t rr = esp_reset_reason();
    uint32_t extra = 0;
    switch (rr) {
    case ESP_RST_POWERON:
    case ESP_RST_UNKNOWN:
    case ESP_RST_EXT:
    case ESP_RST_WDT: // зокрема апаратний сторож вище: зависання могло бути через живлення
        break;
    case ESP_RST_BROWNOUT:
        extra = BROWNOUT_EXTRA_MS;
        break;
    default:
        return; // програмний перезапуск, OTA, сторож: живлення в порядку, не чекаємо
    }
    uint32_t ms = extra + s_rand % (START_DELAY_MAX_MS + 1);
    ESP_LOGI(TAG, "пауза %u мс перед Wi-Fi (старт: %s)", (unsigned)ms, device_reset_reason());
    vTaskDelay(pdMS_TO_TICKS(ms));
}
