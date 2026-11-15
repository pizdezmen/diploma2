// Вбудований світлодіод (доповнення «led», PROTOCOL.md 3.7): адресний RGB (WS2812) або звичайний на GPIO.
// Підключення за замовчуванням з Kconfig; сайт може змінити його в config (тип, вивід, інверсія),
// щоб підібрати правильне для конкретної плати без перепрошивки.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "led_strip.h"
#include "sdkconfig.h"
#include "dm.h"

static const char *TAG = "led";
static SemaphoreHandle_t s_lock;
static led_mode_t s_mode = LED_OFF;
static esp_timer_handle_t s_blink;
static bool s_lit;

static led_hw_t s_hw;                 // поточне підключення
static led_strip_handle_t s_strip;    // для LED_HW_STRIP
static bool s_ready;

void status_led_default_hw(led_hw_t *hw)
{
#if CONFIG_DM_LED_TYPE_STRIP
    hw->type = LED_HW_STRIP;
    hw->active_low = false;
#else
    hw->type = LED_HW_GPIO;
#if CONFIG_DM_LED_ACTIVE_LOW
    hw->active_low = true;
#else
    hw->active_low = false;
#endif
#endif
    hw->gpio = CONFIG_DM_LED_GPIO;
}

static void hw_set(bool on)
{
    s_lit = on;
    if (!s_ready) return;
    if (s_hw.type == LED_HW_STRIP) {
        if (on) {
            led_strip_set_pixel(s_strip, 0, 0, 40, 0); // приглушений зелений
            led_strip_refresh(s_strip);
        } else {
            led_strip_clear(s_strip);
        }
    } else {
        gpio_set_level(s_hw.gpio, on != s_hw.active_low);
    }
}

static void blink_cb(void *arg)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    hw_set(!s_lit);
    xSemaphoreGive(s_lock);
}

static void hw_release(void)
{
    if (!s_ready) return;
    if (s_hw.type == LED_HW_STRIP) {
        led_strip_clear(s_strip);
        led_strip_del(s_strip);
        s_strip = NULL;
    } else {
        gpio_set_level(s_hw.gpio, s_hw.active_low);
    }
    gpio_reset_pin(s_hw.gpio);
    s_ready = false;
}

static void hw_init(void)
{
    if (s_hw.type == LED_HW_STRIP) {
        led_strip_config_t sc = { .strip_gpio_num = s_hw.gpio, .max_leds = 1 };
        led_strip_rmt_config_t rc = { .resolution_hz = 10 * 1000 * 1000 };
        if (led_strip_new_rmt_device(&sc, &rc, &s_strip) != ESP_OK) {
            ESP_LOGW(TAG, "не вдалося ініціалізувати WS2812 на GPIO%d", s_hw.gpio);
            s_strip = NULL;
            return;
        }
        ESP_LOGI(TAG, "RGB WS2812 на GPIO%d", s_hw.gpio);
    } else {
        gpio_config_t io = { .pin_bit_mask = 1ULL << s_hw.gpio, .mode = GPIO_MODE_OUTPUT };
        if (gpio_config(&io) != ESP_OK) {
            ESP_LOGW(TAG, "не вдалося налаштувати GPIO%d", s_hw.gpio);
            return;
        }
        ESP_LOGI(TAG, "світлодіод на GPIO%d%s", s_hw.gpio, s_hw.active_low ? " (інверсний)" : "");
    }
    s_ready = true;
}

void status_led_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    status_led_default_hw(&s_hw);
    hw_init();
    const esp_timer_create_args_t a = { .callback = blink_cb, .name = "led_blink" };
    esp_timer_create(&a, &s_blink);
    hw_set(false);
}

void status_led_configure(const led_hw_t *hw)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (hw->type != s_hw.type || hw->gpio != s_hw.gpio || hw->active_low != s_hw.active_low) {
        hw_release();
        s_hw = *hw;
        hw_init();
        hw_set(s_mode == LED_ON || (s_mode == LED_BLINK && s_lit));
    }
    xSemaphoreGive(s_lock);
}

void status_led_get_hw(led_hw_t *hw, bool *ok)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *hw = s_hw;
    if (ok) *ok = s_ready;
    xSemaphoreGive(s_lock);
}

void status_led_set(led_mode_t mode)
{
    esp_timer_stop(s_blink);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_mode = mode;
    hw_set(mode != LED_OFF);
    xSemaphoreGive(s_lock);
    if (mode == LED_BLINK) esp_timer_start_periodic(s_blink, 250 * 1000);
}

const char *status_led_mode_str(void)
{
    switch (s_mode) {
    case LED_ON:    return "on";
    case LED_BLINK: return "blink";
    default:        return "off";
    }
}
