// Вбудований світлодіод: на S3 RGB WS2812, на C3 звичайний на GPIO.
#include "esp_timer.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "sdkconfig.h"
#include "dm.h"
#if CONFIG_DM_LED_TYPE_STRIP
#include "led_strip.h"
static led_strip_handle_t s_strip;
#endif

static const char *TAG = "led";
static led_mode_t s_mode = LED_OFF;
static esp_timer_handle_t s_blink;
static bool s_lit;

static void hw_set(bool on)
{
    s_lit = on;
#if CONFIG_DM_LED_TYPE_STRIP
    if (!s_strip) return;
    if (on) {
        led_strip_set_pixel(s_strip, 0, 0, 40, 0); // приглушений зелений
        led_strip_refresh(s_strip);
    } else {
        led_strip_clear(s_strip);
    }
#else
#if CONFIG_DM_LED_ACTIVE_LOW
    gpio_set_level(CONFIG_DM_LED_GPIO, on ? 0 : 1);
#else
    gpio_set_level(CONFIG_DM_LED_GPIO, on ? 1 : 0);
#endif
#endif
}

static void blink_cb(void *arg) { hw_set(!s_lit); }

void status_led_init(void)
{
#if CONFIG_DM_LED_TYPE_STRIP
    led_strip_config_t sc = {
        .strip_gpio_num = CONFIG_DM_LED_GPIO,
        .max_leds = 1,
    };
    led_strip_rmt_config_t rc = {
        .resolution_hz = 10 * 1000 * 1000,
    };
    if (led_strip_new_rmt_device(&sc, &rc, &s_strip) != ESP_OK) {
        ESP_LOGW(TAG, "не вдалося ініціалізувати WS2812 на GPIO%d", CONFIG_DM_LED_GPIO);
        s_strip = NULL;
    }
#else
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << CONFIG_DM_LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&io);
#endif
    const esp_timer_create_args_t a = { .callback = blink_cb, .name = "led_blink" };
    esp_timer_create(&a, &s_blink);
    hw_set(false);
}

void status_led_set(led_mode_t mode)
{
    esp_timer_stop(s_blink);
    s_mode = mode;
    switch (mode) {
    case LED_ON:    hw_set(true); break;
    case LED_OFF:   hw_set(false); break;
    case LED_BLINK: hw_set(true); esp_timer_start_periodic(s_blink, 250 * 1000); break;
    }
}

const char *status_led_mode_str(void)
{
    switch (s_mode) {
    case LED_ON:    return "on";
    case LED_BLINK: return "blink";
    default:        return "off";
    }
}
