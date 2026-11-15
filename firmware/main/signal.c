// Обробка вимірів на модулі до надсилання (PROTOCOL.md 3.5): фільтри і межі норми.
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "dm.h"

void filt_reset(filt_t *f)
{
    f->n = 0;
    f->pos = 0;
    f->ema_init = false;
}

static int cmp_float(const void *a, const void *b)
{
    float x = *(const float *)a, y = *(const float *)b;
    return (x > y) - (x < y);
}

float filt_apply(filt_t *f, float x)
{
    if (isnan(x)) return x; // немає виміру: стан фільтра не чіпаємо
    switch (f->type) {
    case FILT_EMA:
        if (!f->ema_init) {
            f->ema = x;
            f->ema_init = true;
        } else {
            f->ema += f->alpha * (x - f->ema);
        }
        return f->ema;
    case FILT_AVG:
    case FILT_MEDIAN: {
        uint8_t w = f->window;
        if (w < 2) return x;
        f->buf[f->pos] = x;
        f->pos = (f->pos + 1) % w;
        if (f->n < w) f->n++;
        if (f->type == FILT_AVG) {
            float s = 0;
            for (int i = 0; i < f->n; i++) s += f->buf[i];
            return s / f->n;
        }
        float tmp[FILT_MAX_WINDOW];
        memcpy(tmp, f->buf, f->n * sizeof(float));
        qsort(tmp, f->n, sizeof(float), cmp_float);
        return (f->n & 1) ? tmp[f->n / 2] : (tmp[f->n / 2 - 1] + tmp[f->n / 2]) / 2;
    }
    default:
        return x;
    }
}

bool limit_update(limit_t *l, float v)
{
    if (!l->has_min && !l->has_max) {
        l->alarm = false;
        return false;
    }
    if (isnan(v)) return l->alarm; // немає виміру: стан не змінюється
    if (!l->alarm) {
        if ((l->has_max && v > l->max) || (l->has_min && v < l->min)) l->alarm = true;
    } else {
        // Повернення в норму з запасом (гістерезис), щоб не «дзвеніло» на межі.
        bool ok_max = !l->has_max || v <= l->max - l->hyst;
        bool ok_min = !l->has_min || v >= l->min + l->hyst;
        if (ok_max && ok_min) l->alarm = false;
    }
    return l->alarm;
}
