// Значення для розробки з secrets.h (не в git). Збірка для сайту робиться з -D DM_NO_SECRETS=1,
// тоді модуль без налаштувань у NVS чекає їх через USB-порт (PROTOCOL.md 6.2).
#pragma once
#if !defined(DM_NO_SECRETS) && __has_include("secrets.h")
#include "secrets.h"
#define DM_HAVE_SECRETS 1
#endif
