-- Схема бази. Виконується при кожному старті сервера, тому всі команди ідемпотентні.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS groups (
    id          serial PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    interval_s  integer CHECK (interval_s BETWEEN 1 AND 3600),
    note        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modules (
    id                  text PRIMARY KEY,           -- MAC без двокрапок
    name                text NOT NULL DEFAULT '',
    note                text NOT NULL DEFAULT '',
    group_id            integer REFERENCES groups(id) ON DELETE SET NULL,
    chip                text,
    fw                  text,
    idf                 text,
    ip                  text,
    ssid                text,
    reset_reason        text,
    led                 text,
    caps                jsonb NOT NULL DEFAULT '[]',
    online              boolean NOT NULL DEFAULT false,
    interval_s          integer CHECK (interval_s BETWEEN 1 AND 3600), -- NULL = як у групи / за замовчуванням
    config_rev          integer NOT NULL DEFAULT 0, -- надіслана ревізія
    applied_config_rev  integer NOT NULL DEFAULT 0, -- застосована модулем
    provisioned         boolean NOT NULL DEFAULT false,
    provision_denied_at timestamptz,
    last_values         jsonb NOT NULL DEFAULT '{}',
    last_seen_at        timestamptz,
    last_status_at      timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS modules_group_idx ON modules (group_id);

CREATE TABLE IF NOT EXISTS telemetry (
    time       timestamptz NOT NULL,
    module_id  text NOT NULL,
    metric     text NOT NULL,
    value      double precision NOT NULL
);
SELECT create_hypertable('telemetry', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetry_module_metric_time_idx ON telemetry (module_id, metric, time DESC);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.compression_settings WHERE hypertable_name = 'telemetry') THEN
        ALTER TABLE telemetry SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'module_id, metric',
            timescaledb.compress_orderby = 'time DESC'
        );
    END IF;
END $$;
SELECT add_compression_policy('telemetry', INTERVAL '1 day', if_not_exists => TRUE);

-- Середні за хвилину
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_name = 'telemetry_1m') THEN
        CREATE MATERIALIZED VIEW telemetry_1m
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT time_bucket(INTERVAL '1 minute', time) AS bucket, module_id, metric,
               avg(value) AS avg, min(value) AS min, max(value) AS max, count(*) AS n
        FROM telemetry
        GROUP BY bucket, module_id, metric
        WITH NO DATA;
    END IF;
END $$;
SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- Середні за годину (будуються з хвилинних)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_name = 'telemetry_1h') THEN
        CREATE MATERIALIZED VIEW telemetry_1h
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT time_bucket(INTERVAL '1 hour', bucket) AS bucket, module_id, metric,
               sum(avg * n) / sum(n) AS avg, min(min) AS min, max(max) AS max, sum(n) AS n
        FROM telemetry_1m
        GROUP BY 1, module_id, metric
        WITH NO DATA;
    END IF;
END $$;
SELECT add_continuous_aggregate_policy('telemetry_1h',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS firmware (
    id          serial PRIMARY KEY,
    filename    text NOT NULL,
    chip        text NOT NULL,
    version     text NOT NULL,
    project     text NOT NULL DEFAULT '',
    idf         text NOT NULL DEFAULT '',
    build_time  text NOT NULL DEFAULT '',
    size        integer NOT NULL,
    sha256      text NOT NULL,
    token       text NOT NULL,
    note        text NOT NULL DEFAULT '',
    uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commands (
    id          text PRIMARY KEY,
    module_id   text NOT NULL,
    name        text NOT NULL,
    params      jsonb NOT NULL DEFAULT '{}',
    status      text NOT NULL DEFAULT 'queued', -- queued, sent, in_progress, ok, error, timeout
    progress    integer,
    message     text NOT NULL DEFAULT '',
    batch_id    text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commands_module_idx ON commands (module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commands_status_idx ON commands (status) WHERE status IN ('queued', 'sent', 'in_progress');

CREATE TABLE IF NOT EXISTS events (
    id         bigserial PRIMARY KEY,
    time       timestamptz NOT NULL DEFAULT now(),
    module_id  text,
    level      text NOT NULL DEFAULT 'info', -- info, warning, alarm
    message    text NOT NULL
);
CREATE INDEX IF NOT EXISTS events_module_idx ON events (module_id, time DESC);
CREATE INDEX IF NOT EXISTS events_time_idx ON events (time DESC);

CREATE TABLE IF NOT EXISTS settings (
    key    text PRIMARY KEY,
    value  jsonb NOT NULL
);
INSERT INTO settings (key, value) VALUES
    ('retention_raw_days', '7'),
    ('retention_1m_days', '90'),
    ('retention_1h_days', 'null'),
    ('default_interval_s', '1'),
    ('ota_wave_size', '10')
ON CONFLICT (key) DO NOTHING;
