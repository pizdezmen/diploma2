// Доповнення «екран» (PROTOCOL.md 3.7): OLED 128×64 / 128×32 на I2C. Показує вибрані з сайту
// показники модуля одним із видів: один великим, списком, по черзі. Нічого примусового поверх.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_log.h"
#include "driver/gpio.h"
#include "sdkconfig.h"
#include "addons.h"
#include "i2c_bus.h"
#include "oled.h"
#include "gfx.h"
#include "dm.h"

static const char *TAG = "display";

#define ITEMS_MAX   12
#define RETRY_MS    5000
#define REDRAW_MS   500
#define W           128

#if CONFIG_IDF_TARGET_ESP32C3
#define DEF_SDA 5
#define DEF_SCL 6
#define DEF_BTN 9   // кнопка BOOT
#else
#define DEF_SDA 8
#define DEF_SCL 9
#define DEF_BTN 0   // кнопка BOOT
#endif

typedef enum { VIEW_BIG, VIEW_LIST, VIEW_CYCLE } view_t;

typedef struct {
    char src[33];   // назва показника або службовий пункт "@name", "@link" ...
    char label[40];
    char unit[16];
} item_t;

typedef struct {
    // налаштування
    bool     enabled;
    int      sda, scl, button;
    uint8_t  addr, contrast;
    uint32_t off_after_ms;  // 0 = не гасити
    view_t   view;
    uint32_t cycle_ms;
    item_t   items[ITEMS_MAX];
    int      n_items;
    oled_t   oled;
    // стан
    i2c_master_bus_handle_t bus;
    bool     ready, powered, btn_ok, scanned;
    int      btn_prev;
    int64_t  next_try, last_draw, awake_until, page_at;
    int      page;
    char     err[ADDON_ERR_LEN];
    uint8_t  fb[W * 64 / 8];
} disp_t;

// ---------- налаштування ----------
static int get_int(const cJSON *o, const char *k, int def)
{
    const cJSON *v = cJSON_GetObjectItem(o, k);
    return cJSON_IsNumber(v) ? (int)v->valuedouble : def;
}

static const char *get_str(const cJSON *o, const char *k, const char *def)
{
    const cJSON *v = cJSON_GetObjectItem(o, k);
    return cJSON_IsString(v) ? v->valuestring : def;
}

static int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

static void *create(const cJSON *cfg, char *err, size_t err_len)
{
    disp_t *d = calloc(1, sizeof(*d));
    if (!d) {
        snprintf(err, err_len, "бракує пам'яті");
        return NULL;
    }
    const cJSON *en = cJSON_GetObjectItem(cfg, "enabled");
    d->enabled = !cJSON_IsBool(en) || cJSON_IsTrue(en);
    const char *drv = get_str(cfg, "driver", "ssd1306");
    if (strcmp(drv, "ssd1306") == 0 || strcmp(drv, "ssd1315") == 0) d->oled.driver = OLED_SSD1306;
    else if (strcmp(drv, "sh1106") == 0) d->oled.driver = OLED_SH1106;
    else {
        snprintf(err, err_len, "невідомий контролер екрана «%s»", drv);
        goto fail;
    }
    d->sda = get_int(cfg, "sda", DEF_SDA);
    d->scl = get_int(cfg, "scl", DEF_SCL);
    d->button = get_int(cfg, "button", DEF_BTN);
    d->addr = (uint8_t)clamp(get_int(cfg, "addr", 0x3C), 0x08, 0x77);
    d->oled.width = W;
    d->oled.height = get_int(cfg, "height", 64) == 32 ? 32 : 64;
    const cJSON *flip = cJSON_GetObjectItem(cfg, "flip");
    d->oled.flip = cJSON_IsTrue(flip);
    int br = clamp(get_int(cfg, "brightness", 100), 1, 100);
    d->contrast = (uint8_t)(br * 255 / 100);
    d->off_after_ms = (uint32_t)clamp(get_int(cfg, "off_after_s", 0), 0, 86400) * 1000;
    const char *view = get_str(cfg, "view", "list");
    d->view = strcmp(view, "big") == 0 ? VIEW_BIG : strcmp(view, "cycle") == 0 ? VIEW_CYCLE : VIEW_LIST;
    d->cycle_ms = (uint32_t)clamp(get_int(cfg, "cycle_s", 5), 1, 3600) * 1000;

    if (!addons_gpio_usable(d->sda, err, err_len) || !addons_gpio_usable(d->scl, err, err_len)) goto fail;
    if (d->sda == d->scl) {
        snprintf(err, err_len, "SDA і SCL не можуть бути на одному виводі");
        goto fail;
    }
    if (d->button >= 0) {
        if (!addons_gpio_usable(d->button, err, err_len)) goto fail;
        if (d->button == d->sda || d->button == d->scl) {
            snprintf(err, err_len, "кнопка на тому самому виводі, що й екран");
            goto fail;
        }
    }

    const cJSON *it;
    cJSON_ArrayForEach(it, cJSON_GetObjectItem(cfg, "items")) {
        if (d->n_items >= ITEMS_MAX) break;
        const char *src = get_str(it, "src", "");
        if (!src[0]) continue;
        item_t *i = &d->items[d->n_items++];
        strlcpy(i->src, src, sizeof(i->src));
        strlcpy(i->label, get_str(it, "label", src), sizeof(i->label));
        strlcpy(i->unit, get_str(it, "unit", ""), sizeof(i->unit));
    }
    snprintf(d->err, sizeof(d->err), "запускається");
    return d;
fail:
    free(d);
    return NULL;
}

static void release_hw(disp_t *d)
{
    if (d->oled.dev) {
        i2c_master_bus_rm_device(d->oled.dev);
        d->oled.dev = NULL;
    }
    if (d->bus) {
        i2c_bus_release(d->bus);
        d->bus = NULL;
    }
    d->ready = false;
    d->powered = false;
}

static void destroy(void *inst)
{
    disp_t *d = inst;
    if (d->ready) oled_power(&d->oled, false); // прибране з налаштувань доповнення гасне
    release_hw(d);
    if (d->btn_ok) gpio_reset_pin(d->button);
    free(d);
}

// Екран не відповів: пояснюємо, що на шині, щоб було зрозуміло, що перевірити.
// Повне сканування лише раз на нові налаштування, далі повторюємо попередній висновок.
static void describe_bus(disp_t *d, esp_err_t pe)
{
    if (d->scanned) return;
    d->scanned = true;
    char found[64] = "";
    int n = 0;
    if (pe != ESP_ERR_TIMEOUT) {
        for (int a = 0x08; a <= 0x77 && n < 6; a++) {
            if (i2c_master_probe(d->bus, a, 20) == ESP_OK) {
                size_t l = strlen(found);
                snprintf(found + l, sizeof(found) - l, "%s0x%02X", n ? ", " : "", a);
                n++;
            }
        }
    }
    if (pe == ESP_ERR_TIMEOUT) {
        snprintf(d->err, sizeof(d->err), "шина I2C не відповідає (GPIO%d, %d): перевірте, чи не переплутані SDA і SCL та чи є живлення",
                 d->sda, d->scl);
    } else if (n) {
        snprintf(d->err, sizeof(d->err), "за адресою 0x%02X екрана немає, на шині знайдено: %s", d->addr, found);
    } else {
        snprintf(d->err, sizeof(d->err), "на шині I2C (SDA GPIO%d, SCL GPIO%d) нічого не знайдено: перевірте дроти й живлення 3V3",
                 d->sda, d->scl);
    }
    addons_utf8_fix(d->err);
    ESP_LOGW(TAG, "%s", d->err);
}

static bool init_hw(disp_t *d, int64_t now)
{
    if (!i2c_bus_exists(d->sda, d->scl)) {
        int stuck = i2c_bus_stuck_line(d->sda, d->scl);
        if (stuck >= 0) {
            snprintf(d->err, sizeof(d->err), "лінія %s (GPIO%d) притиснута до землі: перевірте дроти, чи не переплутані VCC і GND",
                     stuck == d->sda ? "SDA" : "SCL", stuck);
            addons_utf8_fix(d->err);
            return false;
        }
    }
    esp_err_t e = i2c_bus_acquire(d->sda, d->scl, &d->bus);
    if (e != ESP_OK) {
        d->bus = NULL;
        snprintf(d->err, sizeof(d->err), e == ESP_ERR_INVALID_STATE ? "вивід SDA/SCL уже зайнятий іншою шиною I2C"
                 : e == ESP_ERR_NOT_FOUND ? "немає вільного контролера I2C" : "не вдалося запустити I2C: %s",
                 esp_err_to_name(e));
        return false;
    }
    esp_err_t pe = i2c_master_probe(d->bus, d->addr, 50);
    if (pe != ESP_OK) {
        describe_bus(d, pe);
        release_hw(d);
        return false;
    }
    i2c_device_config_t dc = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = d->addr,
        .scl_speed_hz = 400000,
    };
    if (i2c_master_bus_add_device(d->bus, &dc, &d->oled.dev) != ESP_OK) {
        d->oled.dev = NULL;
        snprintf(d->err, sizeof(d->err), "не вдалося додати екран на шину I2C");
        release_hw(d);
        return false;
    }
    gfx_t g = { .buf = d->fb, .w = W, .h = d->oled.height };
    gfx_clear(&g);
    if (oled_init(&d->oled, d->contrast) != ESP_OK || oled_flush(&d->oled, d->fb) != ESP_OK) {
        snprintf(d->err, sizeof(d->err), "помилка обміну з екраном");
        release_hw(d);
        return false;
    }
    if (d->button >= 0 && !d->btn_ok) {
        gpio_config_t io = { .pin_bit_mask = 1ULL << d->button, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE };
        d->btn_ok = gpio_config(&io) == ESP_OK;
        d->btn_prev = 1;
    }
    d->ready = true;
    d->err[0] = '\0';
    d->awake_until = now + d->off_after_ms;
    d->page_at = now;
    d->last_draw = 0;
    ESP_LOGI(TAG, "екран 0x%02X на SDA GPIO%d, SCL GPIO%d готовий", d->addr, d->sda, d->scl);
    return true;
}

// ---------- значення пунктів ----------
static void fmt_duration(char *buf, size_t len, uint32_t s)
{
    uint32_t d = s / 86400, h = s / 3600 % 24, m = s / 60 % 60;
    if (d) snprintf(buf, len, "%luд %02lu:%02lu", (unsigned long)d, (unsigned long)h, (unsigned long)m);
    else snprintf(buf, len, "%02lu:%02lu:%02lu", (unsigned long)h, (unsigned long)m, (unsigned long)(s % 60));
}

static void item_value(const item_t *i, char *buf, size_t len)
{
    const char *s = i->src;
    if (s[0] == '@') {
        if (strcmp(s, "@name") == 0) {
            addons_module_name(buf, len);
            if (!buf[0]) strlcpy(buf, device_id(), len);
        } else if (strcmp(s, "@id") == 0) {
            strlcpy(buf, device_id(), len);
        } else if (strcmp(s, "@fw") == 0) {
            strlcpy(buf, device_fw_version(), len);
        } else if (strcmp(s, "@ip") == 0) {
            if (wifi_mgr_is_connected()) wifi_mgr_ip(buf, len); else strlcpy(buf, "—", len);
        } else if (strcmp(s, "@ssid") == 0) {
            strlcpy(buf, wifi_mgr_is_connected() ? wifi_mgr_ssid() : "—", len);
        } else if (strcmp(s, "@link") == 0) {
            strlcpy(buf, !wifi_mgr_is_connected() ? "немає Wi-Fi" : !mqtt_link_connected() ? "немає сервера" : "на зв'язку", len);
        } else {
            strlcpy(buf, "?", len);
        }
        return;
    }
    float v;
    int dec;
    if (!telemetry_value(s, &v, &dec)) {
        strlcpy(buf, "—", len);
    } else if (strcmp(s, "uptime_s") == 0) {
        fmt_duration(buf, len, (uint32_t)v);
    } else {
        snprintf(buf, len, "%.*f", dec, (double)v);
    }
}

// Одиниці з пробілом, крім «°C», «%» тощо.
static void with_unit(char *buf, size_t len, const char *value, const char *unit)
{
    if (!unit[0] || strcmp(value, "—") == 0) strlcpy(buf, value, len);
    else snprintf(buf, len, "%s%s%s", value, (unit[0] == '%' || (uint8_t)unit[0] == 0xC2) ? "" : " ", unit);
}

// ---------- малювання ----------
static void draw_centered(gfx_t *g, int y, const font_t *f, int scale, const char *s)
{
    int w = gfx_text_width(f, scale, s);
    gfx_text(g, w < g->w ? (g->w - w) / 2 : 0, y, f, scale, s, g->w);
}

// Один пункт великим: підпис угорі, значення посередині якомога більшим шрифтом.
static void draw_big(gfx_t *g, const item_t *i)
{
    char val[48];
    item_value(i, val, sizeof(val));
    const font_t *sm = &font_6x10, *bg = &font_10x20;
    draw_centered(g, 0, sm, 1, i->label);

    bool unit = i->unit[0] && strcmp(val, "—") != 0;
    int uw = unit ? 2 + gfx_text_width(sm, 1, i->unit) : 0;
    const font_t *f = bg;
    int scale = g->h >= 64 ? 2 : 1;
    while (scale > 1 && gfx_text_width(f, scale, val) + uw > g->w) scale--;
    if (gfx_text_width(f, scale, val) + uw > g->w) f = sm;

    // Цифри великого шрифту займають верхню частину клітинки: центруємо за висотою «ascent».
    int area_top = sm->h + 1, area_h = g->h - area_top;
    int vh = (f == bg ? 13 : f->ascent - 1) * scale; // видима висота цифр
    int top_pad = f == bg ? 3 * scale : 1;          // порожні рядки над цифрами в гліфі
    int y = area_top + (area_h - vh) / 2 - top_pad;
    int total = gfx_text_width(f, scale, val) + uw;
    int x = total < g->w ? (g->w - total) / 2 : 0;
    x = gfx_text(g, x, y, f, scale, val, g->w);
    if (unit) {
        int base = y + f->ascent * scale;           // базова лінія значення
        gfx_text(g, x + 2, base - sm->ascent, sm, 1, i->unit, g->w);
    }
}

// Список: підпис ліворуч, значення праворуч, по рядку на пункт.
static void draw_list(gfx_t *g, const item_t *items, int n)
{
    const font_t *f = &font_6x10;
    for (int k = 0; k < n; k++) {
        char val[48], txt[64];
        item_value(&items[k], val, sizeof(val));
        with_unit(txt, sizeof(txt), val, items[k].unit);
        int y = k * f->h;
        int vw = gfx_text_width(f, 1, txt);
        if (vw > g->w) vw = g->w;
        int lx_max = g->w - vw - f->w; // між підписом і значенням хоча б один пробіл
        if (lx_max > 0) gfx_text(g, 0, y, f, 1, items[k].label, lx_max);
        gfx_text(g, g->w - vw, y, f, 1, txt, g->w);
    }
}

static void render(disp_t *d, int64_t now)
{
    gfx_t g = { .buf = d->fb, .w = W, .h = d->oled.height };
    gfx_clear(&g);
    if (d->n_items == 0) return;
    int per_page = d->view == VIEW_LIST ? g.h / font_6x10.h : 1;
    int pages = d->view == VIEW_BIG ? 1 : (d->n_items + per_page - 1) / per_page;
    if (pages > 1 && now - d->page_at >= (int64_t)d->cycle_ms) {
        d->page = (d->page + 1) % pages;
        d->page_at = now;
    }
    if (d->page >= pages) d->page = 0;
    if (d->view == VIEW_LIST) {
        int first = d->page * per_page;
        int n = d->n_items - first < per_page ? d->n_items - first : per_page;
        draw_list(&g, d->items + first, n);
    } else {
        draw_big(&g, &d->items[d->page]);
    }
}

// ---------- цикл ----------
static void tick(void *inst, int64_t now)
{
    disp_t *d = inst;
    if (!d->ready) {
        if (now < d->next_try) return;
        d->next_try = now + RETRY_MS;
        if (!init_hw(d, now)) return;
    }
    // Кнопка: натискання будить екран, а якщо він уже світиться, гортає далі.
    if (d->btn_ok) {
        int lvl = gpio_get_level(d->button);
        if (lvl == 0 && d->btn_prev == 1) {
            bool lit = d->powered;
            d->awake_until = now + d->off_after_ms;
            if (lit && d->view != VIEW_BIG) {
                d->page++;
                d->page_at = now;
                d->last_draw = 0;
            }
        }
        d->btn_prev = lvl;
    }
    bool on = d->enabled && (d->off_after_ms == 0 || now < d->awake_until);
    esp_err_t e = ESP_OK;
    if (on && now - d->last_draw >= REDRAW_MS) {
        render(d, now);
        e = oled_flush(&d->oled, d->fb);
        d->last_draw = now;
    }
    if (e == ESP_OK && on != d->powered) {
        e = oled_power(&d->oled, on);
        if (e == ESP_OK) d->powered = on;
    }
    if (e != ESP_OK) {
        snprintf(d->err, sizeof(d->err), "зв'язок з екраном втрачено (0x%02X)", d->addr);
        ESP_LOGW(TAG, "%s", d->err);
        release_hw(d);
        d->next_try = now + RETRY_MS;
    }
}

static bool state(void *inst, char *err, size_t len)
{
    disp_t *d = inst;
    strlcpy(err, d->err, len);
    return d->ready;
}

const addon_type_t addon_display_type = {
    .name = "display",
    .create = create,
    .destroy = destroy,
    .tick = tick,
    .state = state,
};
