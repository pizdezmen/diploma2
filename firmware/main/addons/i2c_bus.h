// Спільні шини I2C для доповнень: кілька пристроїв на тих самих виводах ділять одну шину.
#pragma once

#include "esp_err.h"
#include "driver/i2c_master.h"

// Повертає шину на цих виводах (створює, якщо ще немає). ESP_ERR_INVALID_STATE: вивід уже
// зайнятий іншою шиною; ESP_ERR_NOT_FOUND: вільних контролерів I2C немає (S3 має 2, C3 має 1).
esp_err_t i2c_bus_acquire(int sda, int scl, i2c_master_bus_handle_t *out);
void      i2c_bus_release(i2c_master_bus_handle_t bus);
