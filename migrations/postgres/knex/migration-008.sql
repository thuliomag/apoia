-- Equivalente PostgreSQL de migrations/mysql/knex/migration-008.sql (ver nota em
-- migration-007.sql sobre a série 001-008 faltante no lado PostgreSQL).

ALTER TABLE ia_user
  ADD COLUMN name VARCHAR(256) NULL,
  ADD COLUMN cpf VARCHAR(11) NULL,
  ADD COLUMN email VARCHAR(64) NULL,
  ADD COLUMN unit_id INT NULL,
  ADD COLUMN unit_name VARCHAR(256) NULL,
  ADD COLUMN court_id INT NULL,
  ADD COLUMN court_name VARCHAR(256) NULL,
  ADD COLUMN state_abbreviation VARCHAR(2) NULL;

-- MySQL usa INT UNSIGNED e uma STORED GENERATED COLUMN com IFNULL; Postgres não tem
-- unsigned (INT comum) e usa COALESCE no lugar de IFNULL para a coluna gerada.
CREATE TABLE ia_user_daily_usage (
    id INT NOT NULL GENERATED ALWAYS AS IDENTITY,
    usage_date DATE NOT NULL,
    user_id INT NULL,
    court_id INT NOT NULL,
    _internal_user_id_key INT GENERATED ALWAYS AS (COALESCE(user_id, -1)) STORED,
    usage_count INT NOT NULL DEFAULT 0,
    input_tokens_count INT NOT NULL DEFAULT 0,
    output_tokens_count INT NOT NULL DEFAULT 0,
    approximate_cost NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
    PRIMARY KEY (id),
    CONSTRAINT uk_date_court_user UNIQUE (usage_date, court_id, _internal_user_id_key),
    CONSTRAINT fk_ia_user_daily_usage_user_id FOREIGN KEY (user_id) REFERENCES ia_user (id) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX fk_ia_user_daily_usage_user_id_idx ON ia_user_daily_usage (user_id);
