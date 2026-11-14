// Налаштування модуля через нативний USB (USB Serial/JTAG), PROTOCOL.md 6.2.
// Запит: рядок JSON + "\n"; відповідь: "DM:" + JSON + "\n". Журнал ESP-IDF іде в той самий порт.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_log.h"
#include "cJSON.h"
#include "dm.h"

static const char *TAG = "serial";

#define CMD_LINE_MAX 1024

static void reply(cJSON *j)
{
    char *s = cJSON_PrintUnformatted(j);
    printf("\nDM:%s\n", s);
    fflush(stdout);
    cJSON_free(s);
    cJSON_Delete(j);
}

static void reply_error(const char *msg)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "ok", false);
    cJSON_AddStringToObject(j, "error", msg);
    reply(j);
}

static void cmd_info(void)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "ok", true);
    cJSON_AddStringToObject(j, "id", device_id());
    cJSON_AddStringToObject(j, "chip", device_chip());
    cJSON_AddStringToObject(j, "fw", device_fw_version());
    cJSON_AddBoolToObject(j, "configured", netcfg_configured());
    reply(j);
}

// Копіює рядкове поле; false, якщо поля немає, воно не рядок або задовге.
static bool get_str(const cJSON *o, const char *key, char *dst, size_t len, bool required)
{
    const cJSON *v = cJSON_GetObjectItem(o, key);
    if (!v) {
        dst[0] = '\0';
        return !required;
    }
    if (!cJSON_IsString(v) || strlen(v->valuestring) >= len) return false;
    if (required && !v->valuestring[0]) return false;
    strlcpy(dst, v->valuestring, len);
    return true;
}

static void cmd_provision(const cJSON *j)
{
    static dm_netcfg_t c;
    memset(&c, 0, sizeof(c));

    const cJSON *wifi = cJSON_GetObjectItem(j, "wifi");
    int n = cJSON_IsArray(wifi) ? cJSON_GetArraySize(wifi) : 0;
    if (n < 1 || n > 2) {
        reply_error("wifi: need 1-2 networks");
        return;
    }
    for (int i = 0; i < n; i++) {
        const cJSON *w = cJSON_GetArrayItem(wifi, i);
        if (!cJSON_IsObject(w) ||
            !get_str(w, "ssid", c.wifi[i].ssid, sizeof(c.wifi[i].ssid), true) ||
            !get_str(w, "pass", c.wifi[i].pass, sizeof(c.wifi[i].pass), false)) {
            reply_error("wifi: ssid 1-32 bytes, pass up to 64 bytes");
            return;
        }
        size_t pl = strlen(c.wifi[i].pass);
        if (pl > 0 && pl < 8) {
            reply_error("wifi: pass must be empty or 8-64 chars");
            return;
        }
    }
    if (!get_str(j, "server_url", c.server_url, sizeof(c.server_url), true) ||
        (strncmp(c.server_url, "http://", 7) != 0 && strncmp(c.server_url, "https://", 8) != 0)) {
        reply_error("server_url must start with http:// or https://");
        return;
    }
    size_t ul = strlen(c.server_url);
    while (ul > 0 && c.server_url[ul - 1] == '/') c.server_url[--ul] = '\0';

    if (!get_str(j, "mqtt_host", c.mqtt_host, sizeof(c.mqtt_host), true)) {
        reply_error("mqtt_host required");
        return;
    }
    const cJSON *port = cJSON_GetObjectItem(j, "mqtt_port");
    if (!cJSON_IsNumber(port) || port->valuedouble < 1 || port->valuedouble > 65535) {
        reply_error("mqtt_port must be 1-65535");
        return;
    }
    c.mqtt_port = (uint16_t)port->valuedouble;
    const cJSON *tls = cJSON_GetObjectItem(j, "mqtt_tls");
    if (!cJSON_IsBool(tls)) {
        reply_error("mqtt_tls must be true or false");
        return;
    }
    c.mqtt_tls = cJSON_IsTrue(tls);
    if (!get_str(j, "token", c.token, sizeof(c.token), true)) {
        reply_error("token required");
        return;
    }

    if (netcfg_save(&c) != ESP_OK) {
        reply_error("cannot save to flash");
        return;
    }
    settings_erase_mqtt_pass(); // нова реєстрація на сервері
    ESP_LOGI(TAG, "налаштування збережено, мережа %s, сервер %s; перезапуск", c.wifi[0].ssid, c.server_url);

    cJSON *r = cJSON_CreateObject();
    cJSON_AddBoolToObject(r, "ok", true);
    cJSON_AddStringToObject(r, "id", device_id());
    reply(r);
    device_restart_after_ms(1000);
}

static void handle_line(char *line)
{
    // Пропускаємо пробіли й можливий \r.
    while (*line == ' ' || *line == '\r' || *line == '\t') line++;
    size_t l = strlen(line);
    while (l > 0 && (line[l - 1] == '\r' || line[l - 1] == ' ')) line[--l] = '\0';
    if (!l) return;
    if (line[0] != '{') return; // не наш запит (наприклад, випадкові символи терміналу)

    cJSON *j = cJSON_Parse(line);
    if (!j) {
        reply_error("bad json");
        return;
    }
    const cJSON *cmd = cJSON_GetObjectItem(j, "cmd");
    if (cJSON_IsString(cmd) && strcmp(cmd->valuestring, "info") == 0) cmd_info();
    else if (cJSON_IsString(cmd) && strcmp(cmd->valuestring, "provision") == 0) cmd_provision(j);
    else reply_error("unknown cmd");
    cJSON_Delete(j);
}

static void task(void *arg)
{
    static char line[CMD_LINE_MAX + 1];
    size_t len = 0;
    bool overflow = false;
    uint8_t buf[64];
    for (;;) {
        int n = usb_serial_jtag_read_bytes(buf, sizeof(buf), portMAX_DELAY);
        for (int i = 0; i < n; i++) {
            char ch = (char)buf[i];
            if (ch == '\n') {
                line[len] = '\0';
                if (overflow) reply_error("line too long");
                else handle_line(line);
                len = 0;
                overflow = false;
            } else if (len < CMD_LINE_MAX) {
                line[len++] = ch;
            } else {
                overflow = true;
            }
        }
    }
}

void serial_cfg_start(void)
{
    usb_serial_jtag_driver_config_t cfg = {
        .rx_buffer_size = 1024,
        .tx_buffer_size = 1024,
    };
    if (usb_serial_jtag_driver_install(&cfg) != ESP_OK) {
        ESP_LOGE(TAG, "не вдалося запустити USB Serial/JTAG");
        return;
    }
    usb_serial_jtag_vfs_use_driver(); // журнал і відповіді йдуть через той самий драйвер
    xTaskCreate(task, "serial_cfg", 4096, NULL, 5, NULL);
}
