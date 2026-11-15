// Монохромні OLED-контролери на I2C: SSD1306, SSD1315 (сумісний за командами) і SH1106.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "driver/i2c_master.h"

typedef enum { OLED_SSD1306, OLED_SH1106 } oled_driver_t;

typedef struct {
    i2c_master_dev_handle_t dev;
    oled_driver_t driver;
    uint8_t width, height; // 128×64 або 128×32
    bool flip;             // повернути на 180°
} oled_t;

esp_err_t oled_init(const oled_t *o, uint8_t contrast); // після init екран вимкнено
esp_err_t oled_power(const oled_t *o, bool on);
esp_err_t oled_contrast(const oled_t *o, uint8_t contrast);
// fb: width*height/8 байт, по сторінках (8 рядків), біт 0 = верхній рядок сторінки.
esp_err_t oled_flush(const oled_t *o, const uint8_t *fb);
