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
        "netcfg.c"
        "serial_cfg.c"
        "signal.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash esp_wifi esp_netif esp_event esp_timer esp_http_client
        esp_https_ota app_update mqtt json mbedtls esp_driver_tsens
        esp_driver_gpio esp_app_format spi_flash esp_psram
        esp_driver_usb_serial_jtag
)

# Збірка для сайту: без значень із secrets.h (idf.py ... -D DM_NO_SECRETS=1)
if(DM_NO_SECRETS)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DM_NO_SECRETS=1)
endif()
