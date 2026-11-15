// Ядро доповнень: реєстр типів, застосування конфігурації, задача опитування, стан у status.
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "soc/soc_caps.h"
#include "driver/gpio.h"
#include "sdkconfig.h"
#include "addons.h"
#include "dm.h"

static const char *TAG = "addons";

extern const addon_type_t addon_display_type;

// Усі типи доповнень, які вміє ця прошивка.
static const addon_type_t *const TYPES[] = {
    &addon_display_type,
};
#define N_TYPES (sizeof(TYPES) / sizeof(TYPES[0]))

typedef struct {
    char                id[17];
    char                type_name[17];
    const addon_type_t *type;   // NULL: невідомий тип або хибні налаштування
    void               *inst;
    char                err[ADDON_ERR_LEN];
    bool                ok;     // останній повідомлений стан
} slot_t;

// Слоти належать лише задачі доповнень: робота з апаратом (I2C тощо) іде без спільних блокувань,
// тож навіть якщо доповнення застрягне, зв'язок із сервером і status не чекають на нього.
static slot_t s_slots[ADDONS_MAX];
static int    s_count;
static char  *s_last;            // текст масиву addons, щоб не перестворювати однакове

// Спільне з іншими задачами (коротке блокування): нова конфігурація, назва, знімок стану.
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static char  *s_pending;         // новий масив addons від addons_apply_config (NULL = без змін)
static bool   s_has_pending;
static char   s_name[64];
typedef struct { char id[17]; char type[17]; bool ok; char err[ADDON_ERR_LEN]; } snap_t;
static snap_t s_snap[ADDONS_MAX];
static int    s_snap_n;

// Захист від зависання: перед кожним викликом доповнення записуємо його id у пам'ять, що переживає
// перезапуск. Якщо сторожовий таймер перезапустив плату посеред виклику, це доповнення після старту
// не запускається, доки не зміняться налаштування доповнень.
#define GUARD_MAGIC 0x41444421u  // "ADD!"
static RTC_NOINIT_ATTR uint32_t s_guard_magic;
static RTC_NOINIT_ATTR char     s_guard_id[17];
static char s_blocked_id[17];    // доповнення, на якому плата зависла минулого разу
#define WDT_TIMEOUT_MS 8000

void addons_utf8_fix(char *s)
{
    size_t n = strlen(s);
    if (!n) return;
    size_t i = n;
    while (i > 0 && ((uint8_t)s[i - 1] & 0xC0) == 0x80) i--; // байти-продовження в кінці
    if (i == 0) { s[0] = '\0'; return; }
    uint8_t lead = (uint8_t)s[i - 1];
    size_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    if (n - (i - 1) < need) s[i - 1] = '\0';
}

static const addon_type_t *find_type(const char *name)
{
    for (size_t i = 0; i < N_TYPES; i++) {
        if (strcmp(TYPES[i]->name, name) == 0) return TYPES[i];
    }
    return NULL;
}

// Вивід, який плата використовує сама (USB, flash, PSRAM) або якого немає.
static bool board_pin_ok(int gpio, char *err, size_t err_len)
{
    if (!GPIO_IS_VALID_GPIO(gpio)) {
        snprintf(err, err_len, "GPIO%d не існує на цьому чипі", gpio);
        return false;
    }
#if CONFIG_IDF_TARGET_ESP32S3
    // 19, 20: USB; 26–32: flash; 33–37: PSRAM (N16R8, octal)
    bool busy = gpio == 19 || gpio == 20 || (gpio >= 26 && gpio <= 37);
#elif CONFIG_IDF_TARGET_ESP32C3
    // 18, 19: USB; 11–17: flash
    bool busy = gpio == 18 || gpio == 19 || (gpio >= 11 && gpio <= 17);
#else
    bool busy = false;
#endif
    if (busy) {
        snprintf(err, err_len, "GPIO%d зайнятий платою (USB, flash або PSRAM)", gpio);
        return false;
    }
    return true;
}

bool addons_gpio_usable(int gpio, char *err, size_t err_len)
{
    if (!board_pin_ok(gpio, err, err_len)) return false;
    led_hw_t led;
    status_led_get_hw(&led, NULL);
    if (gpio == led.gpio) {
        snprintf(err, err_len, "GPIO%d зайнятий світлодіодом", gpio);
        return false;
    }
    return true;
}

static bool is_led(const cJSON *it)
{
    const cJSON *type = cJSON_GetObjectItem(it, "type");
    return cJSON_IsString(type) && strcmp(type->valuestring, "led") == 0;
}

static void destroy_all(void)
{
    for (int i = 0; i < s_count; i++) {
        if (s_slots[i].type && s_slots[i].inst) s_slots[i].type->destroy(s_slots[i].inst);
    }
    memset(s_slots, 0, sizeof(s_slots));
    s_count = 0;
}

static void create_all(const cJSON *arr)
{
    const cJSON *it;
    cJSON_ArrayForEach(it, arr) {
        if (s_count >= ADDONS_MAX) {
            ESP_LOGW(TAG, "більше %d доповнень не підтримується", ADDONS_MAX);
            break;
        }
        if (!cJSON_IsObject(it) || is_led(it)) continue; // світлодіод вбудований, див. apply_led
        const cJSON *id = cJSON_GetObjectItem(it, "id"), *type = cJSON_GetObjectItem(it, "type");
        slot_t *s = &s_slots[s_count++];
        strlcpy(s->id, cJSON_IsString(id) ? id->valuestring : "?", sizeof(s->id));
        strlcpy(s->type_name, cJSON_IsString(type) ? type->valuestring : "?", sizeof(s->type_name));
        s->type = find_type(s->type_name);
        if (!s->type) {
            char e[ADDON_ERR_LEN];
            snprintf(e, sizeof(e), "прошивка не знає тип «%.16s»", s->type_name);
            strlcpy(s->err, e, sizeof(s->err));
        } else if (s_blocked_id[0] && strcmp(s->id, s_blocked_id) == 0) {
            s->type = NULL;
            strlcpy(s->err, "плата зависла під час роботи з цим доповненням і перезапустилася; вимкнено до зміни налаштувань. Перевірте дроти",
                    sizeof(s->err));
            addons_utf8_fix(s->err);
        } else {
            s->inst = s->type->create(it, s->err, sizeof(s->err));
            if (!s->inst) s->type = NULL;
            else strlcpy(s->err, "запускається", sizeof(s->err));
        }
        ESP_LOGI(TAG, "%s (%s): %s", s->id, s->type_name, s->type ? "створено" : s->err);
    }
}

// Вбудований світлодіод: запис {"type":"led","id":"led",...} змінює лише його підключення.
// Без запису — підключення за замовчуванням із Kconfig.
static int num_or(const cJSON *o, const char *k, int def, int lo, int hi)
{
    const cJSON *v = cJSON_GetObjectItem(o, k);
    if (!cJSON_IsNumber(v)) return def;
    return v->valueint < lo ? lo : v->valueint > hi ? hi : v->valueint;
}

static void apply_led(const cJSON *arr)
{
    led_hw_t hw;
    led_look_t look;
    status_led_default_hw(&hw);
    status_led_default_look(&look);
    const cJSON *it;
    cJSON_ArrayForEach(it, arr) {
        if (!is_led(it)) continue;
        const cJSON *drv = cJSON_GetObjectItem(it, "driver"), *g = cJSON_GetObjectItem(it, "gpio");
        if (cJSON_IsString(drv)) hw.type = strcmp(drv->valuestring, "ws2812") == 0 ? LED_HW_STRIP : LED_HW_GPIO;
        char err[ADDON_ERR_LEN];
        if (cJSON_IsNumber(g) && GPIO_IS_VALID_OUTPUT_GPIO(g->valueint) && board_pin_ok(g->valueint, err, sizeof(err))) {
            hw.gpio = g->valueint;
        }
        hw.active_low = cJSON_IsTrue(cJSON_GetObjectItem(it, "active_low"));
        const cJSON *c = cJSON_GetObjectItem(it, "color");
        unsigned rgb;
        if (cJSON_IsString(c) && sscanf(c->valuestring, "#%6x", &rgb) == 1) {
            look.r = rgb >> 16; look.g = rgb >> 8; look.b = rgb;
        }
        look.brightness = (uint8_t)num_or(it, "brightness", look.brightness, 1, 100);
        look.period_ms = (uint16_t)num_or(it, "period_ms", look.period_ms, 100, 10000);
        look.show_status = cJSON_IsTrue(cJSON_GetObjectItem(it, "show_status"));
        break;
    }
    status_led_configure(&hw, &look);
}

void addons_apply_config(const char *json, int len)
{
    cJSON *j = cJSON_ParseWithLength(json, len);
    if (!cJSON_IsObject(j)) {
        cJSON_Delete(j);
        return;
    }
    const cJSON *name = cJSON_GetObjectItem(j, "name");
    const cJSON *arr = cJSON_GetObjectItem(j, "addons");
    char *text = cJSON_IsArray(arr) ? cJSON_PrintUnformatted(arr) : NULL;
    apply_led(arr);
    // Самі доповнення перестворює задача доповнень: тут лише передаємо їй новий список.
    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(s_name, cJSON_IsString(name) ? name->valuestring : "", sizeof(s_name));
    free(s_pending);
    s_pending = text ? strdup(text) : NULL;
    s_has_pending = true;
    xSemaphoreGive(s_lock);
    cJSON_free(text);
    cJSON_Delete(j);
    if (s_task) xTaskNotifyGive(s_task);
}

void addons_module_name(char *buf, size_t len)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(buf, s_name, len);
    xSemaphoreGive(s_lock);
}

void addons_add_caps(cJSON *caps)
{
    cJSON_AddItemToArray(caps, cJSON_CreateString("addons"));
    for (size_t i = 0; i < N_TYPES; i++) cJSON_AddItemToArray(caps, cJSON_CreateString(TYPES[i]->name));
}

void addons_add_status(cJSON *status)
{
    cJSON *arr = cJSON_AddArrayToObject(status, "addons");
    // Вбудований світлодіод — таке саме доповнення, лише вбудоване в плату: його не налаштовують
    // із сайту, а керують командою led (PROTOCOL.md 3.3).
    cJSON *led = cJSON_CreateObject();
    cJSON_AddStringToObject(led, "id", "led");
    cJSON_AddStringToObject(led, "type", "led");
    cJSON_AddBoolToObject(led, "builtin", true);

    led_hw_t lh;
    bool led_ok;
    status_led_get_hw(&lh, &led_ok);
    char hw[40];
    snprintf(hw, sizeof(hw), lh.type == LED_HW_STRIP ? "RGB WS2812, GPIO%d" : "GPIO%d%s", lh.gpio,
             lh.type == LED_HW_GPIO && lh.active_low ? ", інверсний" : "");
    cJSON_AddBoolToObject(led, "ok", led_ok);
    if (!led_ok) cJSON_AddStringToObject(led, "error", "не вдалося запустити світлодіод на цьому виводі");
    cJSON_AddStringToObject(led, "hw", hw);
    cJSON_AddStringToObject(led, "driver", lh.type == LED_HW_STRIP ? "ws2812" : "gpio");
    cJSON_AddNumberToObject(led, "gpio", lh.gpio);
    cJSON_AddBoolToObject(led, "active_low", lh.active_low);
    cJSON_AddStringToObject(led, "state", status_led_mode_str());
    cJSON_AddItemToArray(arr, led);

    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < s_snap_n; i++) {
        const snap_t *s = &s_snap[i];
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "id", s->id);
        cJSON_AddStringToObject(o, "type", s->type);
        cJSON_AddBoolToObject(o, "ok", s->ok);
        if (!s->ok && s->err[0]) cJSON_AddStringToObject(o, "error", s->err);
        cJSON_AddItemToArray(arr, o);
    }
    xSemaphoreGive(s_lock);
}

static void guard_set(const char *id)
{
    strlcpy(s_guard_id, id, sizeof(s_guard_id));
    s_guard_magic = GUARD_MAGIC;
}

static void guard_clear(void) { s_guard_magic = 0; }

// Застосовує новий список доповнень (у задачі доповнень).
static void take_pending(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool has = s_has_pending;
    char *text = s_pending;
    s_pending = NULL;
    s_has_pending = false;
    xSemaphoreGive(s_lock);
    if (!has) return;
    bool same = (text == NULL && s_last == NULL) || (text && s_last && strcmp(text, s_last) == 0);
    if (same) {
        free(text);
        return;
    }
    if (s_last) s_blocked_id[0] = '\0'; // налаштування змінилися: дати ще одну спробу
    guard_set("*destroy");
    destroy_all();
    guard_clear();
    cJSON *arr = text ? cJSON_Parse(text) : NULL;
    if (cJSON_IsArray(arr)) create_all(arr);
    cJSON_Delete(arr);
    free(s_last);
    s_last = text;
}

static void task(void *arg)
{
    esp_task_wdt_add(NULL);
    for (;;) {
        take_pending();
        bool changed = false;
        int64_t now = esp_timer_get_time() / 1000;
        for (int i = 0; i < s_count; i++) {
            slot_t *s = &s_slots[i];
            bool ok = false;
            char err[ADDON_ERR_LEN] = "";
            if (s->type) {
                guard_set(s->id);
                s->type->tick(s->inst, now);
                guard_clear();
                ok = s->type->state(s->inst, err, sizeof(err));
                addons_utf8_fix(err);
            } else {
                strlcpy(err, s->err, sizeof(err));
            }
            if (ok != s->ok || strcmp(err, s->err) != 0) {
                if (ok != s->ok) ESP_LOGI(TAG, "%s: %s", s->id, ok ? "працює" : err);
                s->ok = ok;
                strlcpy(s->err, err, sizeof(s->err));
                changed = true;
            }
            esp_task_wdt_reset();
        }
        if (changed || s_snap_n != s_count) {
            xSemaphoreTake(s_lock, portMAX_DELAY);
            for (int i = 0; i < s_count; i++) {
                strlcpy(s_snap[i].id, s_slots[i].id, sizeof(s_snap[i].id));
                strlcpy(s_snap[i].type, s_slots[i].type_name, sizeof(s_snap[i].type));
                s_snap[i].ok = s_slots[i].ok;
                strlcpy(s_snap[i].err, s_slots[i].err, sizeof(s_snap[i].err));
            }
            s_snap_n = s_count;
            xSemaphoreGive(s_lock);
            mqtt_link_publish_status();
        }
        esp_task_wdt_reset();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
    }
}

void addons_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    esp_reset_reason_t rr = esp_reset_reason();
    bool wdt = rr == ESP_RST_TASK_WDT || rr == ESP_RST_INT_WDT || rr == ESP_RST_WDT || rr == ESP_RST_PANIC;
    if (wdt && s_guard_magic == GUARD_MAGIC) {
        s_guard_id[sizeof(s_guard_id) - 1] = '\0';
        strlcpy(s_blocked_id, s_guard_id, sizeof(s_blocked_id));
        ESP_LOGW(TAG, "минулого разу плата зависла на доповненні «%s»: його не запускаємо", s_blocked_id);
    }
    guard_clear();
    // Сторожовий таймер задач: якщо доповнення зависне довше WDT_TIMEOUT_MS, плата перезапуститься
    // (замість того, щоб висіти без зв'язку), а доповнення буде вимкнено (див. вище).
    esp_task_wdt_config_t wc = { .timeout_ms = WDT_TIMEOUT_MS, .idle_core_mask = 0, .trigger_panic = true };
    if (esp_task_wdt_reconfigure(&wc) == ESP_ERR_INVALID_STATE) esp_task_wdt_init(&wc);
    xTaskCreate(task, "addons", 4096, NULL, 4, &s_task);
}
