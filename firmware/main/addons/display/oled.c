#include <string.h>
#include "oled.h"

#define TIMEOUT_MS 100

static esp_err_t cmds(const oled_t *o, const uint8_t *c, size_t n)
{
    uint8_t buf[32];
    buf[0] = 0x00; // далі команди
    memcpy(buf + 1, c, n);
    return i2c_master_transmit(o->dev, buf, n + 1, TIMEOUT_MS);
}

esp_err_t oled_init(const oled_t *o, uint8_t contrast)
{
    const uint8_t seg = o->flip ? 0xA0 : 0xA1;   // напрям стовпців
    const uint8_t com = o->flip ? 0xC0 : 0xC8;   // напрям рядків
    if (o->driver == OLED_SH1106) {
        const uint8_t c[] = {
            0xAE, 0xD5, 0x80, 0xA8, (uint8_t)(o->height - 1), 0xD3, 0x00, 0x40,
            0xAD, 0x8B,                 // вбудований перетворювач напруги
            seg, com, 0xDA, 0x12, 0x81, contrast, 0xD9, 0x22, 0xDB, 0x35, 0x32, 0xA4, 0xA6,
        };
        return cmds(o, c, sizeof(c));
    }
    const uint8_t c[] = {
        0xAE, 0xD5, 0x80, 0xA8, (uint8_t)(o->height - 1), 0xD3, 0x00, 0x40,
        0x8D, 0x14,                     // вбудований підвищувач (charge pump)
        0x20, 0x02,                     // посторінкова адресація, як у SH1106
        seg, com, 0xDA, (uint8_t)(o->height == 64 ? 0x12 : 0x02),
        0x81, contrast, 0xD9, 0xF1, 0xDB, 0x40, 0x2E, 0xA4, 0xA6,
    };
    return cmds(o, c, sizeof(c));
}

esp_err_t oled_power(const oled_t *o, bool on)
{
    const uint8_t c[] = { on ? 0xAF : 0xAE };
    return cmds(o, c, 1);
}

esp_err_t oled_contrast(const oled_t *o, uint8_t contrast)
{
    const uint8_t c[] = { 0x81, contrast };
    return cmds(o, c, 2);
}

esp_err_t oled_flush(const oled_t *o, const uint8_t *fb)
{
    const uint8_t col = o->driver == OLED_SH1106 ? 2 : 0; // SH1106 має 132 стовпці, видимі з 2-го
    uint8_t buf[1 + 128];
    for (int p = 0; p < o->height / 8; p++) {
        const uint8_t c[] = { (uint8_t)(0xB0 | p), (uint8_t)(col & 0x0F), (uint8_t)(0x10 | (col >> 4)) };
        esp_err_t err = cmds(o, c, sizeof(c));
        if (err != ESP_OK) return err;
        buf[0] = 0x40; // далі дані
        memcpy(buf + 1, fb + p * o->width, o->width);
        err = i2c_master_transmit(o->dev, buf, o->width + 1, TIMEOUT_MS);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}
