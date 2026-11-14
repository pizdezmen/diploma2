// Оновлення прошивки по Wi-Fi (PROTOCOL.md 4). Два слоти, без автоматичного відкату.
#include <string.h>
#include <stdio.h>
#include <strings.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_https_ota.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "mbedtls/sha256.h"
#include "dm.h"

static const char *TAG = "ota";

static volatile bool s_busy;
static ota_request_t s_req;

bool ota_busy(void) { return s_busy; }

// SHA-256 перших len байт записаного розділу.
static esp_err_t partition_sha256_hex(const esp_partition_t *p, uint32_t len, char out[65])
{
    static uint8_t buf[1024];
    uint8_t hash[32];
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);
    for (uint32_t off = 0; off < len; ) {
        uint32_t n = len - off > sizeof(buf) ? sizeof(buf) : len - off;
        esp_err_t err = esp_partition_read(p, off, buf, n);
        if (err != ESP_OK) {
            mbedtls_sha256_free(&ctx);
            return err;
        }
        mbedtls_sha256_update(&ctx, buf, n);
        off += n;
    }
    mbedtls_sha256_finish(&ctx, hash);
    mbedtls_sha256_free(&ctx);
    for (int i = 0; i < 32; i++) sprintf(out + i * 2, "%02x", hash[i]);
    return ESP_OK;
}

static void fail(esp_https_ota_handle_t h, const char *msg)
{
    ESP_LOGE(TAG, "помилка: %s", msg);
    if (h) esp_https_ota_abort(h);
    commands_ack(s_req.id, "error", -1, msg);
}

static void ota_task(void *arg)
{
    char msg[96];
    esp_https_ota_handle_t h = NULL;
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);

    ESP_LOGI(TAG, "оновлення з %s у розділ %s", s_req.url, target ? target->label : "?");
    commands_ack(s_req.id, "in_progress", 0, NULL);

    if (s_req.size && target && s_req.size > target->size) {
        snprintf(msg, sizeof(msg), "image %lu B does not fit slot %lu B",
                 (unsigned long)s_req.size, (unsigned long)target->size);
        fail(NULL, msg);
        goto done;
    }

    esp_http_client_config_t http = {
        .url = s_req.url,
        .timeout_ms = 15000,
        .keep_alive_enable = true,
        .crt_bundle_attach = strncmp(s_req.url, "https", 5) == 0 ? esp_crt_bundle_attach : NULL,
    };
    esp_https_ota_config_t cfg = { .http_config = &http };
    esp_err_t err = esp_https_ota_begin(&cfg, &h);
    if (err != ESP_OK) {
        snprintf(msg, sizeof(msg), "download failed: %s", esp_err_to_name(err));
        h = NULL;
        fail(NULL, msg);
        goto done;
    }

    esp_app_desc_t desc;
    if (esp_https_ota_get_img_desc(h, &desc) != ESP_OK) {
        fail(h, "cannot read image header");
        goto done;
    }
    if (strcmp(desc.version, device_fw_version()) == 0) {
        fail(h, "this version is already running");
        goto done;
    }
    if (s_req.version[0] && strcmp(desc.version, s_req.version) != 0) {
        snprintf(msg, sizeof(msg), "image version %s != expected %s", desc.version, s_req.version);
        fail(h, msg);
        goto done;
    }

    int total = s_req.size ? (int)s_req.size : esp_https_ota_get_image_size(h);
    int last_reported = 0;
    while ((err = esp_https_ota_perform(h)) == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
        if (total > 0) {
            int pct = (int)((int64_t)esp_https_ota_get_image_len_read(h) * 100 / total);
            if (pct >= last_reported + 10 && pct < 100) {
                last_reported = pct - pct % 10;
                commands_ack(s_req.id, "in_progress", last_reported, NULL);
            }
        }
    }
    if (err != ESP_OK) {
        snprintf(msg, sizeof(msg), "download failed: %s", esp_err_to_name(err));
        fail(h, msg);
        goto done;
    }
    if (!esp_https_ota_is_complete_data_received(h)) {
        fail(h, "incomplete download");
        goto done;
    }

    uint32_t got = esp_https_ota_get_image_len_read(h);
    if (s_req.size && got != s_req.size) {
        snprintf(msg, sizeof(msg), "size %lu != expected %lu", (unsigned long)got, (unsigned long)s_req.size);
        fail(h, msg);
        goto done;
    }
    if (s_req.sha256[0]) {
        char hex[65];
        if (partition_sha256_hex(target, got, hex) != ESP_OK) {
            fail(h, "cannot read written image");
            goto done;
        }
        if (strcasecmp(hex, s_req.sha256) != 0) {
            fail(h, "sha256 mismatch");
            goto done;
        }
    }

    // finish перевіряє образ і перемикає завантаження на новий слот.
    err = esp_https_ota_finish(h);
    h = NULL;
    if (err != ESP_OK) {
        snprintf(msg, sizeof(msg), "image rejected: %s", esp_err_to_name(err));
        commands_ack(s_req.id, "error", -1, msg);
        goto done;
    }

    ESP_LOGI(TAG, "готово, версія %s, перезапуск", desc.version);
    commands_ack(s_req.id, "ok", 100, NULL);
    mqtt_link_publish_offline("ota");
    device_mark_restart_reason_ota();
    device_restart_after_ms(500);

done:
    s_busy = false;
    vTaskDelete(NULL);
}

esp_err_t ota_start(const ota_request_t *req)
{
    if (s_busy) return ESP_ERR_INVALID_STATE;
    s_busy = true;
    s_req = *req;
    if (xTaskCreate(ota_task, "ota", 8192, NULL, 4, NULL) != pdPASS) {
        s_busy = false;
        return ESP_FAIL;
    }
    return ESP_OK;
}
