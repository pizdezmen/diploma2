from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    admin_username: str = "admin"
    admin_password: str = "admin"
    secret_key: str = "dev-secret"
    session_days: int = 7

    db_dsn: str = "postgresql://monitor:monitor@localhost:5432/monitor"

    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_admin_user: str = "server"
    mqtt_admin_password: str = "server"
    mqtt_tls: bool = False
    mqtt_public_port: int = 1883
    provision_token: str = "provision"
    # Хост MQTT, який записується в модулі; порожньо = хост із PUBLIC_URL
    mqtt_public_host: str = ""

    public_url: str = "http://localhost:8080"
    firmware_dir: str = "/data/firmware"

    # Скільки чекати відповіді на команду
    cmd_timeout_s: int = 30
    ota_timeout_s: int = 600


settings = Settings()
