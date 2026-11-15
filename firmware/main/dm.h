// Спільні оголошення модулів прошивки.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

// ---- device_info.c: ідентифікатор та відомості про плату ----
void        device_info_init(void);
const char *device_id(void);           // MAC STA, 12 hex у нижньому регістрі
const char *device_chip(void);         // "esp32s3" / "esp32c3"
const char *device_fw_version(void);
const char *device_reset_reason(void); // за PROTOCOL.md 3.1
void        device_mark_restart_reason_ota(void); // наступний старт покаже reset_reason "ota"
void        device_restart_after_ms(uint32_t ms);
float       device_chip_temp_c(void);

// ---- settings.c: NVS (простір "dm") ----
esp_err_t settings_init(void);
bool      settings_get_mqtt_pass(char *buf, size_t len);
esp_err_t settings_set_mqtt_pass(const char *pass);
esp_err_t settings_erase_mqtt_pass(void);
void      settings_get_config(uint32_t *rev, uint32_t *interval_s);   // старий формат (0.2.0)
char     *settings_get_config_json(void);                           // NULL, якщо немає; звільнити free()
esp_err_t settings_set_config_json(const char *json);

// ---- netcfg.c: мережеві налаштування (NVS з сайту, інакше secrets.h) ----
typedef struct {
    struct { char ssid[33]; char pass[65]; } wifi[2]; // [1].ssid порожній = запасної немає
    char     server_url[128];
    char     mqtt_host[96];
    uint16_t mqtt_port;
    bool     mqtt_tls;
    char     token[80];
} dm_netcfg_t;
void               netcfg_load(void);
const dm_netcfg_t *netcfg(void);
bool               netcfg_configured(void); // збережено в NVS
bool               netcfg_usable(void);     // є з чим підключатися
esp_err_t          netcfg_save(const dm_netcfg_t *c);

// ---- serial_cfg.c: команди info / provision через USB ----
void serial_cfg_start(void);

// ---- wifi_mgr.c ----
void wifi_mgr_start(void);
bool wifi_mgr_wait_connected(uint32_t timeout_ms);
bool wifi_mgr_is_connected(void);
int  wifi_mgr_rssi(void);               // 0, якщо не підключено
void wifi_mgr_ip(char *buf, size_t len);
const char *wifi_mgr_ssid(void);

// ---- provision.c: POST /api/provision ----
typedef enum {
    PROVISION_OK,
    PROVISION_BAD_TOKEN,   // 401
    PROVISION_CONFLICT,    // 409
    PROVISION_FAILED,      // мережа / інший код
} provision_result_t;
provision_result_t provision_request(char *pass_out, size_t len);

// ---- mqtt_link.c ----
void mqtt_link_run(void);   // нескінченний цикл: реєстрація → MQTT → повтор
bool mqtt_link_connected(void);
int  mqtt_link_publish(const char *suffix, const char *data, int qos, bool retain);
void mqtt_link_publish_status(void);
void mqtt_link_offline_and_restart(const char *reason); // публікує offline, відключається і перезапускає модуль

// ---- signal.c: фільтри і межі норми ----
#define FILT_MAX_WINDOW 30
typedef enum { FILT_NONE, FILT_AVG, FILT_MEDIAN, FILT_EMA } filt_type_t;
typedef struct {
    filt_type_t type;
    uint8_t     window;              // для AVG і MEDIAN: 2..FILT_MAX_WINDOW
    float       alpha;               // для EMA: 0.01..1
    float       buf[FILT_MAX_WINDOW];
    uint8_t     n, pos;
    float       ema;
    bool        ema_init;
} filt_t;
void  filt_reset(filt_t *f);
float filt_apply(filt_t *f, float x); // NAN проходить без змін

typedef struct {
    bool  has_min, has_max;
    float min, max, hyst;
    bool  alarm;                     // поточний стан: поза нормою
} limit_t;
bool limit_update(limit_t *l, float v); // повертає новий стан alarm

// ---- telemetry.c ----
void     telemetry_start(void);
void     telemetry_apply_config(const char *data, int len);
uint32_t telemetry_config_rev(void);
// Останнє значення показника (після фільтра); false, якщо такого показника немає або ще не виміряно.
bool     telemetry_value(const char *name, float *v, int *decimals);
bool     telemetry_any_alarm(void); // хоч один показник поза межами норми

// ---- commands.c ----
void commands_handle(const char *data, int len);
void commands_ack(const char *id, const char *status, int progress, const char *message);

// ---- ota.c ----
typedef struct {
    char     id[40];
    char     url[384];
    char     version[33];
    uint32_t size;
    char     sha256[65];
} ota_request_t;
esp_err_t ota_start(const ota_request_t *req); // ESP_ERR_INVALID_STATE, якщо вже йде
bool      ota_busy(void);

// ---- status_led.c ----
typedef enum { LED_OFF, LED_ON, LED_BLINK, LED_BREATHE, LED_RAINBOW } led_mode_t;
typedef struct {
    uint8_t  r, g, b;      // колір для «увімк.», блимання і дихання
    uint8_t  brightness;   // 1..100 %
    uint16_t period_ms;    // період блимання, дихання, веселки
    bool     show_status;  // коли вимкнено вручну, показувати стан: зелений / жовтий / червоний
} led_look_t;
typedef enum { LED_HW_GPIO, LED_HW_STRIP } led_hw_type_t;
typedef struct {
    led_hw_type_t type;  // звичайний світлодіод на GPIO або адресний RGB (WS2812)
    int           gpio;
    bool          active_low;
} led_hw_t;
void        status_led_init(void);
void        status_led_default_hw(led_hw_t *hw);           // із Kconfig
void        status_led_default_look(led_look_t *look);
void        status_led_configure(const led_hw_t *hw, const led_look_t *look); // з сайту (доповнення "led")
void        status_led_get_hw(led_hw_t *hw, bool *ok);
void        status_led_set(led_mode_t mode);
const char *status_led_mode_str(void);
