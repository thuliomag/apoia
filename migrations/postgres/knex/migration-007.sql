-- Equivalente PostgreSQL de migrations/mysql/knex/migration-007.sql.
-- As migrations PostgreSQL 001-008 nunca foram portadas (a série em
-- migrations/postgres/knex/ começava direto em migration-009.sql, enquanto o lado
-- MySQL tem 001-033 completo) — um bootstrap de um Postgres novo a partir de
-- migrations/postgres/init.sql falhava a partir da migration-020, que já assume
-- is_latest/share existentes em ia_prompt. Ver ADAPTACAO-ANM.md.

ALTER TABLE ia_prompt
  ADD COLUMN is_latest BOOLEAN NULL DEFAULT false,
  ADD COLUMN share VARCHAR(32) NULL DEFAULT 'PRIVADO';

ALTER TABLE ia_prompt ALTER COLUMN kind DROP NOT NULL;

CREATE INDEX latest ON ia_prompt (is_latest, base_id, id);

ALTER TABLE ia_generation
  ADD COLUMN created_by INT NULL;

CREATE TABLE ia_favorite (
    id INT NOT NULL GENERATED ALWAYS AS IDENTITY,
    user_id INT NOT NULL,
    prompt_id INT NOT NULL,
    level INT NULL DEFAULT 1,
    PRIMARY KEY (id),
    CONSTRAINT favorite_user_id FOREIGN KEY (user_id) REFERENCES ia_user (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT favorite_prompt_id FOREIGN KEY (prompt_id) REFERENCES ia_prompt (id) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX favorite_user_id_idx ON ia_favorite (user_id);
