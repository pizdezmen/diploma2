// Мінімальна графіка для монохромних екранів: пікселі й текст UTF-8 растровими шрифтами.
#pragma once

#include <stdint.h>

typedef struct {
    uint8_t  w, h, bpr;       // розмір клітинки й байтів на рядок гліфа
    uint8_t  ascent;          // від верху клітинки до базової лінії
    uint16_t count;
    const uint16_t *cp;       // кодові точки, відсортовані
    const uint8_t  *bits;
} font_t;

extern const font_t font_6x10;
extern const font_t font_10x20;

typedef struct {
    uint8_t *buf; // w*h/8, по сторінках, як у oled_flush
    int w, h;
} gfx_t;

void gfx_clear(gfx_t *g);
void gfx_pixel(gfx_t *g, int x, int y);
int  gfx_text_len(const char *utf8);                                   // кількість символів
int  gfx_text_width(const font_t *f, int scale, const char *utf8);
// Малює текст з лівого верхнього кута (x, y), не виходячи за max_x. Повертає x після тексту.
int  gfx_text(gfx_t *g, int x, int y, const font_t *f, int scale, const char *utf8, int max_x);
