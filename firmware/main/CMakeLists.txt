if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/secrets.h")
    message(FATAL_ERROR "Немає firmware/main/secrets.h. Скопіюйте secrets.example.h у secrets.h і заповніть.")
endif()

idf_component_register(
    SRCS
        "app_main.c"
        "device_info.c"
        "settings.c"
        "wifi_mgr.c"
        "provision.c"
        "mqtt_link.c"
        "telemetry.c"
        "commands.c"
        "ota.c"
        "status_led.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash esp_wifi esp_netif esp_event esp_timer esp_http_client
        esp_https_ota app_update mqtt json mbedtls esp_driver_tsens
        esp_driver_gpio esp_app_format spi_flash esp_psram
)
