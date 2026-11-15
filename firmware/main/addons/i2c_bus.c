#include "soc/soc_caps.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "driver/gpio.h"
#include "i2c_bus.h"

static const char *TAG = "i2c_bus";

typedef struct {
    int sda, scl, refs;
    i2c_master_bus_handle_t bus;
} bus_t;

// Викликається лише з-під блокування ядра доповнень, тому власного блокування не потрібно.
static bus_t s_buses[SOC_I2C_NUM];

esp_err_t i2c_bus_acquire(int sda, int scl, i2c_master_bus_handle_t *out)
{
    bus_t *free_slot = NULL;
    for (int i = 0; i < SOC_I2C_NUM; i++) {
        bus_t *b = &s_buses[i];
        if (!b->refs) {
            if (!free_slot) free_slot = b;
            continue;
        }
        if (b->sda == sda && b->scl == scl) {
            b->refs++;
            *out = b->bus;
            return ESP_OK;
        }
        if (b->sda == sda || b->sda == scl || b->scl == sda || b->scl == scl) {
            return ESP_ERR_INVALID_STATE;
        }
    }
    if (!free_slot) return ESP_ERR_NOT_FOUND;
    i2c_master_bus_config_t cfg = {
        .i2c_port = -1, // будь-який вільний контролер
        .sda_io_num = sda,
        .scl_io_num = scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true, // на модулях екранів зазвичай є свої підтяжки, ці не завадять
    };
    esp_err_t err = i2c_new_master_bus(&cfg, &free_slot->bus);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "не вдалося створити шину SDA %d, SCL %d: %s", sda, scl, esp_err_to_name(err));
        return err;
    }
    free_slot->sda = sda;
    free_slot->scl = scl;
    free_slot->refs = 1;
    *out = free_slot->bus;
    ESP_LOGI(TAG, "шина I2C: SDA GPIO%d, SCL GPIO%d", sda, scl);
    return ESP_OK;
}

void i2c_bus_release(i2c_master_bus_handle_t bus)
{
    for (int i = 0; i < SOC_I2C_NUM; i++) {
        bus_t *b = &s_buses[i];
        if (b->refs && b->bus == bus && --b->refs == 0) {
            i2c_del_master_bus(b->bus);
            b->bus = NULL;
        }
    }
}

bool i2c_bus_exists(int sda, int scl)
{
    for (int i = 0; i < SOC_I2C_NUM; i++) {
        if (s_buses[i].refs && s_buses[i].sda == sda && s_buses[i].scl == scl) return true;
    }
    return false;
}

int i2c_bus_stuck_line(int sda, int scl)
{
    int pins[2] = { sda, scl };
    int stuck = -1;
    for (int k = 0; k < 2 && stuck < 0; k++) {
        gpio_config_t io = { .pin_bit_mask = 1ULL << pins[k], .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE };
        gpio_config(&io);
        esp_rom_delay_us(200);
        int low = 0;
        for (int n = 0; n < 5; n++) {
            low += gpio_get_level(pins[k]) == 0;
            esp_rom_delay_us(100);
        }
        if (low == 5) stuck = pins[k];
        gpio_reset_pin(pins[k]);
    }
    return stuck;
}
