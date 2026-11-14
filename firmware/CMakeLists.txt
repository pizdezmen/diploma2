cmake_minimum_required(VERSION 3.16)

# Версію прошивки (esp_app_desc_t.version) ESP-IDF бере з файла version.txt у цій папці.
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(dm_module)
