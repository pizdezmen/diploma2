// Спільні шини I2C для доповнень: кілька пристроїв на тих самих виводах ділять одну шину.
#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "driver/i2c_master.h"

// Повертає шину на цих виводах (створює, якщо ще немає). ESP_ERR_INVALID_STATE: вивід уже
// зайнятий іншою шиною; ESP_ERR_NOT_FOUND: вільних контролерів I2C немає (S3 має 2, C3 має 1).
esp_err_t i2c_bus_acquire(int sda, int scl, i2c_master_bus_handle_t *out);
void      i2c_bus_release(i2c_master_bus_handle_t bus);
// Чи вже є шина на цих виводах (тоді виводи зайняті I2C і перевіряти рівні не можна).
bool      i2c_bus_exists(int sda, int scl);
// Перевірка ліній перед створенням шини: з підтяжкою вгору обидві мають бути в 1.
// Повертає -1, якщо все гаразд, інакше номер GPIO, притиснутого до землі.
int       i2c_bus_stuck_line(int sda, int scl);
