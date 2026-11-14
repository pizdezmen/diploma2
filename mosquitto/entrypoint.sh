#!/bin/sh
# Генерує конфігурацію брокера з налаштувань і при першому запуску створює базу облікових записів (dynamic security).
set -e
DATA=/mosquitto/data
CONF=/tmp/mosquitto.conf

if [ ! -f "$DATA/dynamic-security.json" ]; then
  echo "Створюю dynamic-security.json з обліковим записом $MQTT_ADMIN_USER"
  mosquitto_ctrl dynsec init "$DATA/dynamic-security.json" "$MQTT_ADMIN_USER" "$MQTT_ADMIN_PASSWORD"
  chown mosquitto:mosquitto "$DATA/dynamic-security.json" 2>/dev/null || true
fi

cat > "$CONF" <<CONF
persistence true
persistence_location $DATA/
log_dest stdout
log_type error
log_type warning
log_type notice
max_queued_messages 1000

plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file $DATA/dynamic-security.json

# Внутрішній порт для сервера (не публікується назовні)
listener 1883

# Порт для модулів
listener 8883
CONF

if [ "$MQTT_TLS" = "true" ] || [ "$MQTT_TLS" = "1" ]; then
  echo "MQTT: TLS увімкнено"
  cat >> "$CONF" <<CONF
certfile /mosquitto/certs/fullchain.pem
keyfile /mosquitto/certs/privkey.pem
tls_version tlsv1.2
CONF
else
  echo "MQTT: TLS вимкнено"
fi

exec mosquitto -c "$CONF"
