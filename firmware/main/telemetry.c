// Показники плати (PROTOCOL.md 3.2) і конфігурація (3.5): вимір щосекунди, фільтри,
// межі норми, гібридний режим надсилання і передісторія тривоги.
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_log.h"
#include "cJSON.h"
#include "dm.h"
#include "addons.h"

static const char *TAG = "telemetry";

#define INTERVAL_MIN_S 1
#define INTERVAL_MAX_S 3600
#define HISTORY_MAX    60     // передісторія: до 60 вимірів (1 раз на секунду)
#define MSG_MAX_LEN    12000  // < buffer.out_size у mqtt_link.c

// ---------- показники ----------
static float m_rssi(void) { int r = wifi_mgr_rssi(); return r ? (float)r : NAN; }
static float m_uptime(void) { return (float)(esp_timer_get_time() / 1000000); }
static float m_temp(void) { float t = device_chip_temp_c(); return t > -273.0f ? t : NAN; }
static float m_heap(void) { return (float)esp_get_free_heap_size(); }
static float m_heap_min(void) { return (float)esp_get_minimum_free_heap_size(); }

typedef struct {
    const char *name;
    float (*read)(void);
    int decimals; // скільки знаків після коми надсилати
} metric_def_t;

static const metric_def_t METRICS[] = {
    { "rssi",          m_rssi,     0 },
    { "uptime_s",      m_uptime,   0 },
    { "chip_temp_c",   m_temp,     1 },
    { "heap_free",     m_heap,     0 },
    { "heap_min_free", m_heap_min, 0 },
};
#define N_METRICS (sizeof(METRICS) / sizeof(METRICS[0]))

// ---------- конфігурація і стан ----------
typedef struct {
    uint32_t rev;
    uint32_t interval_s;      // звичайний інтервал (і інтервал під час тривоги в гібридному режимі)
    bool     hybrid;
    uint32_t normal_s;        // гібридний режим: інтервал, поки все в нормі
    uint32_t history_s;       // скільки секунд передісторії надсилати разом із тривогою
    filt_t   filt[N_METRICS];
    limit_t  lim[N_METRICS];
} cfg_t;

typedef struct {
    int64_t  ts;              // мс Unix, 0 якщо час невідомий
    uint32_t n;               // номер виміру від старту
    float    v[N_METRICS];
} sample_t;

static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static cfg_t s_cfg = { .interval_s = 1, .normal_s = 60, .history_s = 60 };
static volatile uint32_t s_config_rev;
static uint32_t s_seq;

static sample_t s_hist[HISTORY_MAX];
static uint32_t s_n;              // скільки вимірів зроблено
static uint32_t s_last_sent_n;    // номер останнього надісланого виміру (0 = ще нічого)
static int64_t  s_last_send_us;
static bool     s_pending;        // треба надіслати при першій можливості (зміна стану тривоги)
static bool     s_pending_history;

uint32_t telemetry_config_rev(void) { return s_config_rev; }

bool telemetry_any_alarm(void)
{
    for (int i = 0; i < (int)N_METRICS; i++) {
        if (s_cfg.lim[i].alarm) return true; // читання bool без блокування: найгірше — на крок пізніше
    }
    return false;
}

bool telemetry_value(const char *name, float *v, int *decimals)
{
    int i = -1;
    for (int k = 0; k < (int)N_METRICS; k++) {
        if (strcmp(METRICS[k].name, name) == 0) i = k;
    }
    if (i < 0 || !s_lock) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool ok = s_n > 0;
    if (ok) *v = s_hist[(s_n - 1) % HISTORY_MAX].v[i];
    xSemaphoreGive(s_lock);
    if (decimals) *decimals = METRICS[i].decimals;
    return ok && !isnan(*v);
}

static int64_t now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    if (tv.tv_sec < 1700000000) return 0; // SNTP ще не синхронізувався
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static int metric_index(const char *name)
{
    for (int i = 0; i < (int)N_METRICS; i++) {
        if (strcmp(METRICS[i].name, name) == 0) return i;
    }
    return -1;
}

static double rounded(int i, float v)
{
    double k = METRICS[i].decimals == 1 ? 10.0 : METRICS[i].decimals == 2 ? 100.0 : 1.0;
    return round((double)v * k) / k;
}

// ---------- повідомлення ----------
static void add_values(cJSON *obj, const sample_t *s)
{
    cJSON *v = cJSON_AddObjectToObject(obj, "values");
    for (int i = 0; i < (int)N_METRICS; i++) {
        if (!isnan(s->v[i])) cJSON_AddNumberToObject(v, METRICS[i].name, rounded(i, s->v[i]));
    }
}

static void add_alarms(cJSON *j)
{
    cJSON *a = cJSON_AddArrayToObject(j, "alarms");
    for (int i = 0; i < (int)N_METRICS; i++) {
        if (s_cfg.lim[i].alarm) cJSON_AddItemToArray(a, cJSON_CreateString(METRICS[i].name));
    }
}

// Будує повідомлення: поточний вимір і, якщо history, ще не надіслані виміри за history_s секунд.
static char *build_message(bool history)
{
    const sample_t *cur = &s_hist[(s_n - 1) % HISTORY_MAX];
    int count = 0;
    if (history && s_cfg.history_s > 0) {
        uint32_t oldest = s_n > HISTORY_MAX ? s_n - HISTORY_MAX + 1 : 1;
        uint32_t from_hist = s_n > s_cfg.history_s ? s_n - s_cfg.history_s + 1 : 1;
        if (from_hist > oldest) oldest = from_hist;
        if (s_last_sent_n + 1 > oldest) oldest = s_last_sent_n + 1;
        count = (int)(s_n - oldest); // без поточного
    }
    for (;;) {
        cJSON *j = cJSON_CreateObject();
        cJSON_AddNumberToObject(j, "seq", s_seq);
        if (count > 0) {
            cJSON *arr = cJSON_AddArrayToObject(j, "samples");
            for (uint32_t k = s_n - count; k <= s_n; k++) {
                const sample_t *s = &s_hist[(k - 1) % HISTORY_MAX];
                if (s->ts == 0 && k != s_n) continue; // без часу передісторія не має сенсу
                cJSON *o = cJSON_CreateObject();
                cJSON_AddNumberToObject(o, "ts", (double)s->ts);
                add_values(o, s);
                cJSON_AddItemToArray(arr, o);
            }
        } else {
            cJSON_AddNumberToObject(j, "ts", (double)cur->ts);
            add_values(j, cur);
        }
        add_alarms(j);
        char *out = cJSON_PrintUnformatted(j);
        cJSON_Delete(j);
        if (!out || strlen(out) <= MSG_MAX_LEN || count == 0) return out;
        cJSON_free(out);
        count /= 2; // не влазить у буфер MQTT: скорочуємо передісторію
    }
}

// ---------- один крок (раз на секунду) ----------
// Вимірює і перевіряє межі; повертає повідомлення, якщо час надсилати (інакше NULL).
// Викликається під s_lock; публікація йде вже без нього (див. task).
static char *step(void)
{
    sample_t *s = &s_hist[s_n % HISTORY_MAX];
    s->ts = now_ms();
    s->n = ++s_n;

    bool entered = false, changed = false, any_alarm = false;
    for (int i = 0; i < (int)N_METRICS; i++) {
        float v = filt_apply(&s_cfg.filt[i], METRICS[i].read());
        s->v[i] = v;
        bool was = s_cfg.lim[i].alarm;
        bool now = limit_update(&s_cfg.lim[i], v);
        any_alarm |= now;
        if (now != was) {
            changed = true;
            entered |= now;
            ESP_LOGW(TAG, "%s: %s = %.2f", now ? "тривога" : "норма", METRICS[i].name, v);
        }
    }
    if (changed) s_pending = true;
    if (entered) s_pending_history = true;

    uint32_t period = (s_cfg.hybrid && !any_alarm) ? s_cfg.normal_s : s_cfg.interval_s;
    int64_t t = esp_timer_get_time();
    bool due = s_last_send_us == 0 || t - s_last_send_us >= (int64_t)period * 1000000 - 200000;
    if (!due && !s_pending) return NULL;
    if (!mqtt_link_connected()) return NULL; // спробуємо на наступному кроці; s_pending зберігається
    return build_message(s_pending_history);
}

static void task(void *arg)
{
    TickType_t next = xTaskGetTickCount();
    for (;;) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        char *msg = step();
        uint32_t n = s_n;
        xSemaphoreGive(s_lock);
        // Публікуємо без s_lock: обробник config викликається з задачі MQTT-клієнта,
        // яка в цей час тримає власне блокування, і вкладене очікування дало б взаємоблокування.
        if (msg) {
            bool ok = mqtt_link_publish("telemetry", msg, 0, false) >= 0;
            cJSON_free(msg);
            if (ok) {
                xSemaphoreTake(s_lock, portMAX_DELAY);
                s_seq++;
                s_last_sent_n = n;
                s_last_send_us = esp_timer_get_time();
                s_pending = false;
                s_pending_history = false;
                xSemaphoreGive(s_lock);
            }
        }
        next += pdMS_TO_TICKS(1000);
        TickType_t now = xTaskGetTickCount();
        if ((int32_t)(next - now) <= 0) next = now + 1;
        // Сповіщення від telemetry_apply_config перериває очікування.
        if (ulTaskNotifyTake(pdTRUE, next - now)) {
            next = xTaskGetTickCount();
        }
    }
}

// ---------- розбір конфігурації ----------
static double num(const cJSON *o, const char *key, double def, double lo, double hi)
{
    const cJSON *v = cJSON_GetObjectItem(o, key);
    if (!cJSON_IsNumber(v)) return def;
    double x = v->valuedouble;
    return x < lo ? lo : x > hi ? hi : x;
}

// Розбирає JSON у cfg (стан фільтрів і тривог не переносить). false, якщо це не JSON-об'єкт.
static bool parse_config(const char *data, int len, cfg_t *c)
{
    cJSON *j = cJSON_ParseWithLength(data, len);
    if (!cJSON_IsObject(j)) {
        cJSON_Delete(j);
        return false;
    }
    memset(c, 0, sizeof(*c));
    c->rev = (uint32_t)num(j, "rev", 0, 0, 4e9);
    c->interval_s = (uint32_t)num(j, "interval_s", 1, INTERVAL_MIN_S, INTERVAL_MAX_S);

    const cJSON *h = cJSON_GetObjectItem(j, "hybrid");
    c->hybrid = cJSON_IsObject(h);
    c->normal_s = c->hybrid ? (uint32_t)num(h, "normal_interval_s", 60, INTERVAL_MIN_S, INTERVAL_MAX_S) : 60;
    c->history_s = c->hybrid ? (uint32_t)num(h, "history_s", 60, 0, HISTORY_MAX) : 0;

    const cJSON *it;
    cJSON_ArrayForEach(it, cJSON_GetObjectItem(j, "filters")) {
        int i = it->string ? metric_index(it->string) : -1;
        if (i < 0 || !cJSON_IsObject(it)) continue;
        const cJSON *t = cJSON_GetObjectItem(it, "type");
        const char *ts = cJSON_IsString(t) ? t->valuestring : "";
        filt_t *f = &c->filt[i];
        if (strcmp(ts, "avg") == 0) f->type = FILT_AVG;
        else if (strcmp(ts, "median") == 0) f->type = FILT_MEDIAN;
        else if (strcmp(ts, "ema") == 0) f->type = FILT_EMA;
        else continue;
        f->window = (uint8_t)num(it, "window", 5, 2, FILT_MAX_WINDOW);
        f->alpha = (float)num(it, "alpha", 0.2, 0.01, 1);
    }
    cJSON_ArrayForEach(it, cJSON_GetObjectItem(j, "limits")) {
        int i = it->string ? metric_index(it->string) : -1;
        if (i < 0 || !cJSON_IsObject(it)) continue;
        limit_t *l = &c->lim[i];
        const cJSON *mn = cJSON_GetObjectItem(it, "min"), *mx = cJSON_GetObjectItem(it, "max");
        l->has_min = cJSON_IsNumber(mn);
        l->has_max = cJSON_IsNumber(mx);
        if (l->has_min) l->min = (float)mn->valuedouble;
        if (l->has_max) l->max = (float)mx->valuedouble;
        l->hyst = (float)num(it, "hyst", 0, 0, 1e9);
    }
    cJSON_Delete(j);
    return true;
}

static bool same_filter(const filt_t *a, const filt_t *b)
{
    return a->type == b->type && a->window == b->window && a->alpha == b->alpha;
}

// Застосовує нову конфігурацію, зберігаючи стан фільтрів і тривог, де налаштування не змінилися.
static void install(cfg_t *c)
{
    for (int i = 0; i < (int)N_METRICS; i++) {
        if (same_filter(&c->filt[i], &s_cfg.filt[i])) {
            c->filt[i] = s_cfg.filt[i];
        } else {
            filt_reset(&c->filt[i]);
        }
        c->lim[i].alarm = s_cfg.lim[i].alarm && (c->lim[i].has_min || c->lim[i].has_max);
        if (c->lim[i].alarm != s_cfg.lim[i].alarm) s_pending = true;
    }
    s_cfg = *c;
    s_config_rev = c->rev;
}

void telemetry_start(void)
{
    s_lock = xSemaphoreCreateMutex();
    cfg_t c;
    char *json = settings_get_config_json();
    if (json && parse_config(json, strlen(json), &c)) {
        install(&c);
    } else {
        // Конфігурація прошивки 0.2.0: лише ревізія та інтервал.
        uint32_t rev, interval;
        settings_get_config(&rev, &interval);
        if (interval < INTERVAL_MIN_S || interval > INTERVAL_MAX_S) interval = 1;
        s_cfg.rev = rev;
        s_cfg.interval_s = interval;
        s_config_rev = rev;
    }
    if (json) addons_apply_config(json, strlen(json));
    free(json);
    ESP_LOGI(TAG, "конфігурація з NVS: rev %lu, інтервал %lu с, гібридний %s",
             (unsigned long)s_cfg.rev, (unsigned long)s_cfg.interval_s, s_cfg.hybrid ? "так" : "ні");
    xTaskCreate(task, "telemetry", 6144, NULL, 5, &s_task);
}

void telemetry_apply_config(const char *data, int len)
{
    cfg_t c;
    if (!parse_config(data, len, &c)) {
        ESP_LOGW(TAG, "config: не JSON-об'єкт");
        return;
    }
    if (c.rev == s_config_rev && c.rev != 0) {
        return; // та сама ревізія (retained config після перепідключення)
    }
    char *copy = malloc(len + 1);
    if (copy) {
        memcpy(copy, data, len);
        copy[len] = '\0';
        settings_set_config_json(copy);
        free(copy);
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    install(&c);
    s_last_send_us = 0; // надіслати одразу з новими налаштуваннями
    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "нова конфігурація: rev %lu, інтервал %lu с, гібридний %s (в нормі раз на %lu с, передісторія %lu с)",
             (unsigned long)c.rev, (unsigned long)c.interval_s, c.hybrid ? "так" : "ні",
             (unsigned long)c.normal_s, (unsigned long)c.history_s);
    xTaskNotifyGive(s_task);
    {
        cJSON *j = cJSON_ParseWithLength(data, len);
        const cJSON *v = cJSON_GetObjectItem(j, "wifi_tx_dbm");
        wifi_mgr_set_tx_power(cJSON_IsNumber(v) ? v->valuedouble : 0); // немає поля — найбільша
        cJSON_Delete(j);
    }
    addons_apply_config(data, len); // поза s_lock: задача доповнень сама читає показники під ним
    mqtt_link_publish_status();
}
