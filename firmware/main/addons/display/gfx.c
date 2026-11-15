#include <string.h>
#include "gfx.h"

void gfx_clear(gfx_t *g) { memset(g->buf, 0, g->w * g->h / 8); }

void gfx_pixel(gfx_t *g, int x, int y)
{
    if (x < 0 || y < 0 || x >= g->w || y >= g->h) return;
    g->buf[(y / 8) * g->w + x] |= 1u << (y % 8);
}

// Наступна кодова точка UTF-8; некоректні байти дають '?'.
static uint32_t next_cp(const char **s)
{
    const uint8_t *p = (const uint8_t *)*s;
    uint32_t c = *p++;
    int more = 0;
    if (c >= 0xF0) { c &= 0x07; more = 3; }
    else if (c >= 0xE0) { c &= 0x0F; more = 2; }
    else if (c >= 0xC0) { c &= 0x1F; more = 1; }
    else if (c >= 0x80) { c = '?'; }
    while (more-- > 0) {
        if ((*p & 0xC0) != 0x80) { c = '?'; break; }
        c = (c << 6) | (*p++ & 0x3F);
    }
    *s = (const char *)p;
    return c;
}

static const uint8_t *glyph(const font_t *f, uint32_t cp)
{
    if (cp == 0x2BC || cp == 0x2018) cp = 0x2019; // різні апострофи
    int lo = 0, hi = f->count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (f->cp[mid] == cp) return f->bits + mid * f->h * f->bpr;
        if (f->cp[mid] < cp) lo = mid + 1; else hi = mid - 1;
    }
    return cp == '?' ? NULL : glyph(f, '?');
}

int gfx_text_len(const char *s)
{
    int n = 0;
    while (*s) { next_cp(&s); n++; }
    return n;
}

int gfx_text_width(const font_t *f, int scale, const char *s) { return gfx_text_len(s) * f->w * scale; }

int gfx_text(gfx_t *g, int x, int y, const font_t *f, int scale, const char *s, int max_x)
{
    const int cw = f->w * scale;
    while (*s && x + cw <= max_x) {
        const uint8_t *b = glyph(f, next_cp(&s));
        if (b) {
            for (int r = 0; r < f->h; r++) {
                for (int c = 0; c < f->w; c++) {
                    if (!(b[r * f->bpr + c / 8] & (0x80 >> (c % 8)))) continue;
                    for (int dy = 0; dy < scale; dy++)
                        for (int dx = 0; dx < scale; dx++) gfx_pixel(g, x + c * scale + dx, y + r * scale + dy);
                }
            }
        }
        x += cw;
    }
    return x;
}
