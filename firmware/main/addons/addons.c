// Ядро доповнень: реєстр типів, застосування конфігурації, задача опитування, стан у status.
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
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

static SemaphoreHandle_t s_lock;
static slot_t s_slots[ADDONS_MAX];
static int    s_count;
static char  *s_last;            // текст масиву addons, щоб не перестворювати однакове
static char   s_name[64];

static const addon_type_t *find_type(const char *name)
{
    for (size_t i = 0; i < N_TYPES; i++) {
        if (strcmp(TYPES[i]->name, name) == 0) return TYPES[i];
    }
    return NULL;
}

bool addons_gpio_usable(int gpio, char *err, size_t err_len)
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
    if (gpio == CONFIG_DM_LED_GPIO) {
        snprintf(err, err_len, "GPIO%d зайнятий світлодіодом", gpio);
        return false;
    }
    return true;
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
        if (!cJSON_IsObject(it)) continue;
        const cJSON *id = cJSON_GetObjectItem(it, "id"), *type = cJSON_GetObjectItem(it, "type");
        slot_t *s = &s_slots[s_count++];
        strlcpy(s->id, cJSON_IsString(id) ? id->valuestring : "?", sizeof(s->id));
        strlcpy(s->type_name, cJSON_IsString(type) ? type->valuestring : "?", sizeof(s->type_name));
        s->type = find_type(s->type_name);
        if (!s->type) {
            char e[ADDON_ERR_LEN];
            snprintf(e, sizeof(e), "прошивка не знає тип «%.16s»", s->type_name);
            strlcpy(s->err, e, sizeof(s->err));
        } else {
            s->inst = s->type->create(it, s->err, sizeof(s->err));
            if (!s->inst) s->type = NULL;
        }
        ESP_LOGI(TAG, "%s (%s): %s", s->id, s->type_name, s->type ? "створено" : s->err);
    }
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

    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(s_name, cJSON_IsString(name) ? name->valuestring : "", sizeof(s_name));
    bool same = (text == NULL && s_last == NULL) || (text && s_last && strcmp(text, s_last) == 0);
    if (!same) {
        destroy_all();
        if (cJSON_IsArray(arr)) create_all(arr);
        free(s_last);
        s_last = text ? strdup(text) : NULL;
    }
    xSemaphoreGive(s_lock);
    cJSON_free(text);
    cJSON_Delete(j);
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
    cJSON_AddBoolToObject(led, "ok", true);
    char hw[32];
#if CONFIG_DM_LED_TYPE_STRIP
    snprintf(hw, sizeof(hw), "RGB WS2812, GPIO%d", CONFIG_DM_LED_GPIO);
#else
    snprintf(hw, sizeof(hw), "GPIO%d", CONFIG_DM_LED_GPIO);
#endif
    cJSON_AddStringToObject(led, "hw", hw);
    cJSON_AddStringToObject(led, "state", status_led_mode_str());
    cJSON_AddItemToArray(arr, led);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < s_count; i++) {
        const slot_t *s = &s_slots[i];
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "id", s->id);
        cJSON_AddStringToObject(o, "type", s->type_name);
        cJSON_AddBoolToObject(o, "ok", s->ok);
        if (!s->ok && s->err[0]) cJSON_AddStringToObject(o, "error", s->err);
        cJSON_AddItemToArray(arr, o);
    }
    xSemaphoreGive(s_lock);
}

static void task(void *arg)
{
    for (;;) {
        bool changed = false;
        int64_t now = esp_timer_get_time() / 1000;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        for (int i = 0; i < s_count; i++) {
            slot_t *s = &s_slots[i];
            bool ok = false;
            char err[ADDON_ERR_LEN] = "";
            if (s->type) {
                s->type->tick(s->inst, now);
                ok = s->type->state(s->inst, err, sizeof(err));
            } else {
                strlcpy(err, s->err, sizeof(err));
            }
            if (ok != s->ok || strcmp(err, s->err) != 0) {
                if (ok != s->ok) ESP_LOGI(TAG, "%s: %s", s->id, ok ? "працює" : err);
                s->ok = ok;
                strlcpy(s->err, err, sizeof(s->err));
                changed = true;
            }
        }
        xSemaphoreGive(s_lock);
        // Публікуємо без s_lock: mqtt_link_publish_status сам викликає addons_add_status.
        if (changed) mqtt_link_publish_status();
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void addons_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    xTaskCreate(task, "addons", 4096, NULL, 4, NULL);
}
