// Доповнення модуля (PROTOCOL.md 3.7): екрани, а згодом і інші пристрої, що підключаються до плати.
// Кожен тип доповнення описує addon_type_t; щоб додати новий тип, достатньо написати його функції
// і внести в таблицю TYPES у addons.c. Ядро (addons.c) розбирає поле "addons" конфігурації,
// створює і знищує екземпляри, викликає їх із власної задачі й звітує стан у темі status.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "cJSON.h"

#define ADDONS_MAX     4   // скільки доповнень на одній платі
#define ADDON_ERR_LEN  200 // байт; українські літери по 2 байти

typedef struct addon_type {
    const char *name; // значення поля "type", напр. "display"
    // Створює екземпляр за налаштуваннями (апарат ще не чіпає). NULL, якщо налаштування хибні:
    // тоді в err пояснення українською.
    void *(*create)(const cJSON *cfg, char *err, size_t err_len);
    void  (*destroy)(void *inst);
    // Раз на ~100 мс із задачі доповнень; now_ms — час від старту.
    void  (*tick)(void *inst, int64_t now_ms);
    // Поточний стан: true = працює; інакше в err причина.
    bool  (*state)(void *inst, char *err, size_t err_len);
} addon_type_t;

void        addons_init(void);
// Повна конфігурація з теми config (рядок JSON): поля "addons" і "name".
void        addons_apply_config(const char *json, int len);
// Додає в status поле "addons" зі станом кожного доповнення.
void        addons_add_status(cJSON *status);
// Додає в масив caps "addons" і назви підтримуваних типів.
void        addons_add_caps(cJSON *caps);
// Назва модуля із сайту (поле "name" конфігурації); порожня, якщо не задана.
void        addons_module_name(char *buf, size_t len);

// Обрізає незавершений символ UTF-8 у кінці рядка (після snprintf/strlcpy з обрізанням).
void        addons_utf8_fix(char *s);

// Спільна перевірка GPIO: чи можна вільно використовувати вивід (не USB, не flash/PSRAM, не світлодіод).
bool        addons_gpio_usable(int gpio, char *err, size_t err_len);
