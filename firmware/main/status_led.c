// Вбудований світлодіод (доповнення «led», PROTOCOL.md 3.7): адресний RGB (WS2812) або звичайний на GPIO.
// Підключення за замовчуванням з Kconfig; сайт може змінити його в config (тип, вивід, інверсія),
// а також колір, яскравість, швидкість ефектів і режим «показувати стан».
// Режими (команда led): on, off, blink, breathe (плавне дихання), rainbow (веселка).
// Звичайний світлодіод уміє лише світитися й блимати: breathe для нього — блимання, rainbow — світіння.
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "led_strip.h"
#include "sdkconfig.h"
#include "dm.h"

static const char *TAG = "led";

#define FRAME_US (20 * 1000) // 50 кадрів/с для ефектів

static SemaphoreHandle_t s_lock;
static esp_timer_handle_t s_timer;
static led_mode_t s_mode = LED_OFF;
static int64_t s_mode_since_ms;

static led_hw_t   s_hw;
static led_look_t s_look;
static led_strip_handle_t s_strip;
static bool s_ready;
static uint32_t s_shown = 0xFFFFFFFF; // останній виведений колір, щоб не оновлювати без потреби

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

void status_led_default_look(led_look_t *l)
{
    *l = (led_look_t){ .r = 0, .g = 255, .b = 0, .brightness = 20, .period_ms = 500, .show_status = false };
}

// ---------- вивід на апарат ----------
static void hw_write(uint32_t rgb)
{
    if (!s_ready || rgb == s_shown) return;
    s_shown = rgb;
    uint8_t r = rgb >> 16, g = rgb >> 8, b = rgb;
    if (s_hw.type == LED_HW_STRIP) {
        if (rgb) {
            led_strip_set_pixel(s_strip, 0, r, g, b);
            led_strip_refresh(s_strip);
        } else {
            led_strip_clear(s_strip);
        }
    } else {
        gpio_set_level(s_hw.gpio, (rgb != 0) != s_hw.active_low);
    }
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
    s_shown = 0xFFFFFFFF;
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

// ---------- кадр ----------
static uint32_t pack(float r, float g, float b, float k)
{
    // Яскравість у відсотках; квадрат дає рівніший на око крок на малих значеннях
    float s = k * (s_look.brightness / 100.0f) * (s_look.brightness / 100.0f);
    uint32_t R = (uint32_t)(r * s + 0.5f), G = (uint32_t)(g * s + 0.5f), B = (uint32_t)(b * s + 0.5f);
    if ((r || g || b) && k > 0 && !R && !G && !B) {
        // Найменша яскравість не має гасити світлодіод зовсім
        R = r ? 1 : 0; G = g ? 1 : 0; B = b ? 1 : 0;
    }
    return R << 16 | G << 8 | B;
}

static uint32_t hue(float h, float k)
{
    float x = 1.0f - fabsf(fmodf(h / 60.0f, 2.0f) - 1.0f);
    float r, g, b;
    switch ((int)(h / 60.0f) % 6) {
    case 0: r = 1; g = x; b = 0; break;
    case 1: r = x; g = 1; b = 0; break;
    case 2: r = 0; g = 1; b = x; break;
    case 3: r = 0; g = x; b = 1; break;
    case 4: r = x; g = 0; b = 1; break;
    default: r = 1; g = 0; b = x; break;
    }
    return pack(r * 255, g * 255, b * 255, k);
}

static uint32_t frame(int64_t now_ms)
{
    const led_look_t *l = &s_look;
    uint32_t t = (uint32_t)(now_ms - s_mode_since_ms);
    uint32_t period = l->period_ms ? l->period_ms : 500;
    bool strip = s_hw.type == LED_HW_STRIP;
    led_mode_t mode = s_mode;
    if (!strip && mode == LED_BREATHE) mode = LED_BLINK;
    if (!strip && mode == LED_RAINBOW) mode = LED_ON;

    switch (mode) {
    case LED_ON:
        return pack(l->r, l->g, l->b, 1);
    case LED_BLINK:
        return (t % period) < period / 2 ? pack(l->r, l->g, l->b, 1) : 0;
    case LED_BREATHE: {
        float k = 0.5f - 0.5f * cosf(2.0f * (float)M_PI * (float)(t % period) / (float)period);
        return pack(l->r, l->g, l->b, k);
    }
    case LED_RAINBOW:
        return hue(360.0f * (float)(t % period) / (float)period, 1);
    case LED_OFF:
    default:
        if (!l->show_status) return 0;
        // Стан модуля: червоний — показник поза нормою; жовтий — немає Wi-Fi або сервера; зелений — усе гаразд
        if (telemetry_any_alarm()) return pack(255, 0, 0, 1);
        if (!wifi_mgr_is_connected() || !mqtt_link_connected()) return pack(255, 160, 0, 1);
        return pack(0, 255, 0, 1);
    }
}

static void timer_cb(void *arg)
{
    if (xSemaphoreTake(s_lock, 0) != pdTRUE) return; // зміна налаштувань: пропускаємо кадр
    hw_write(frame(esp_timer_get_time() / 1000));
    xSemaphoreGive(s_lock);
}

// ---------- API ----------
void status_led_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    status_led_default_hw(&s_hw);
    status_led_default_look(&s_look);
    hw_init();
    hw_write(0);
    const esp_timer_create_args_t a = { .callback = timer_cb, .name = "led" };
    esp_timer_create(&a, &s_timer);
    esp_timer_start_periodic(s_timer, FRAME_US);
}

void status_led_configure(const led_hw_t *hw, const led_look_t *look)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (hw->type != s_hw.type || hw->gpio != s_hw.gpio || hw->active_low != s_hw.active_low) {
        hw_release();
        s_hw = *hw;
        hw_init();
    }
    s_look = *look;
    s_shown = 0xFFFFFFFF; // перемалювати з новим кольором
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
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_mode = mode;
    s_mode_since_ms = esp_timer_get_time() / 1000;
    xSemaphoreGive(s_lock);
}

const char *status_led_mode_str(void)
{
    switch (s_mode) {
    case LED_ON:      return "on";
    case LED_BLINK:   return "blink";
    case LED_BREATHE: return "breathe";
    case LED_RAINBOW: return "rainbow";
    default:          return "off";
    }
}
