-- Core schema for treatment plans, stages, events, reminders and catalog.
-- The migration is idempotent: CREATE statements guard against duplicates and enums are created conditionally.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_stage_kind') THEN
    CREATE TYPE plan_stage_kind AS ENUM ('season', 'trigger', 'adhoc');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_type') THEN
    CREATE TYPE event_type AS ENUM ('treatment', 'phi');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
    CREATE TYPE event_status AS ENUM ('scheduled', 'done', 'skipped');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  tg_id         BIGINT NOT NULL UNIQUE,
  last_object_id BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS last_object_id BIGINT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS users_tg_id_key ON users(tg_id);

CREATE TABLE IF NOT EXISTS objects (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT,
  location_tag TEXT,
  meta         JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objects_user ON objects(user_id);

CREATE TABLE IF NOT EXISTS cases (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id  BIGINT REFERENCES objects(id) ON DELETE SET NULL,
  crop       TEXT,
  disease    TEXT,
  confidence DOUBLE PRECISION,
  raw_ai     JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_user ON cases(user_id);
CREATE INDEX IF NOT EXISTS idx_cases_object ON cases(object_id);

CREATE TABLE IF NOT EXISTS plans (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id  BIGINT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  case_id    BIGINT REFERENCES cases(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id);
CREATE INDEX IF NOT EXISTS idx_plans_object ON plans(object_id);

CREATE TABLE IF NOT EXISTS plan_stages (
  id         BIGSERIAL PRIMARY KEY,
  plan_id    BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  kind       plan_stage_kind NOT NULL,
  note       TEXT,
  phi_days   INTEGER,
  meta       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_stages_plan ON plan_stages(plan_id);

CREATE TABLE IF NOT EXISTS stage_options (
  id          BIGSERIAL PRIMARY KEY,
  stage_id    BIGINT NOT NULL REFERENCES plan_stages(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,
  ai          TEXT,
  dose_value  NUMERIC,
  dose_unit   TEXT,
  method      TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_selected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_options_stage ON stage_options(stage_id);

CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id      BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  stage_id     BIGINT REFERENCES plan_stages(id) ON DELETE SET NULL,
  type         event_type NOT NULL,
  due_at       TIMESTAMPTZ,
  status       event_status NOT NULL DEFAULT 'scheduled',
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_plan ON events(plan_id);
CREATE INDEX IF NOT EXISTS idx_events_user_due ON events (user_id, due_at) WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS reminders (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  fire_at    TIMESTAMPTZ NOT NULL,
  sent_at    TIMESTAMPTZ,
  message_id BIGINT,
  payload    JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_event ON reminders(event_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fire_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS products (
  id           BIGSERIAL PRIMARY KEY,
  product      TEXT NOT NULL,
  ai           TEXT,
  form         TEXT,
  constraints  JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product)
);

CREATE TABLE IF NOT EXISTS product_rules (
  id          BIGSERIAL PRIMARY KEY,
  crop        TEXT NOT NULL,
  disease     TEXT NOT NULL,
  region      TEXT,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  dose_value  NUMERIC,
  dose_unit   TEXT,
  phi_days    INTEGER,
  safety      JSONB NOT NULL DEFAULT '{}'::JSONB,
  meta        JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_rules_crop_disease ON product_rules(crop, disease);
CREATE INDEX IF NOT EXISTS idx_product_rules_region ON product_rules(region);
CREATE UNIQUE INDEX IF NOT EXISTS product_rules_unique ON product_rules(crop, disease, COALESCE(region, ''), product_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_last_object_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_last_object_id_fkey
      FOREIGN KEY (last_object_id) REFERENCES objects(id) ON DELETE SET NULL;
  END IF;
END$$;
