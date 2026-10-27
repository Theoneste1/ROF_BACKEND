-- ROF registration backend: initial schema.
-- Additive only: creates new tables, never alters or drops existing ones (the Supabase
-- project also hosts unrelated LMS tables, so every object here uses a distinct name).
-- gen_random_uuid() is built in to PostgreSQL 13+.

CREATE OR REPLACE FUNCTION rof_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Competition editions
-- ---------------------------------------------------------------------------
CREATE TABLE competition_editions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year               integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  registration_open  boolean NOT NULL DEFAULT false,
  is_current         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- At most one edition can be the current one that receives public registrations.
CREATE UNIQUE INDEX competition_editions_one_current ON competition_editions (is_current) WHERE is_current;
CREATE TRIGGER competition_editions_updated BEFORE UPDATE ON competition_editions
  FOR EACH ROW EXECUTE FUNCTION rof_set_updated_at();

-- ---------------------------------------------------------------------------
-- Rwanda administrative geography (seeded from data/rwanda-locations.json)
-- ---------------------------------------------------------------------------
CREATE TABLE provinces (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  name  text NOT NULL UNIQUE
);
CREATE TABLE districts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  province_id  uuid NOT NULL REFERENCES provinces (id),
  name         text NOT NULL,
  UNIQUE (province_id, name),
  UNIQUE (id, province_id)
);
CREATE TABLE sectors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  district_id  uuid NOT NULL REFERENCES districts (id),
  name         text NOT NULL,
  UNIQUE (district_id, name),
  UNIQUE (id, district_id)
);
CREATE INDEX districts_province_idx ON districts (province_id);
CREATE INDEX sectors_district_idx ON sectors (district_id);

-- ---------------------------------------------------------------------------
-- Schools: stable identity across editions. The school code is the official
-- identifier; it is unique here (one school) but NOT unique per registration, so
-- a school can register in every future edition.
-- ---------------------------------------------------------------------------
CREATE TABLE schools (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_code             text NOT NULL,
  school_code_normalized  text NOT NULL UNIQUE,
  name                    text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER schools_updated BEFORE UPDATE ON schools
  FOR EACH ROW EXECUTE FUNCTION rof_set_updated_at();

-- ---------------------------------------------------------------------------
-- Registrations: one row per submission, a full snapshot of what was submitted.
-- ---------------------------------------------------------------------------
CREATE TABLE school_registrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_reference text NOT NULL UNIQUE,
  competition_edition_id uuid NOT NULL REFERENCES competition_editions (id),
  school_id             uuid NOT NULL REFERENCES schools (id),
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','under_review','verified','approved','rejected','withdrawn')),
  status_note           text CHECK (length(status_note) <= 1000),

  -- A. registering contact
  first_name            text,
  last_name             text,
  email_address         text,
  phone_contact         text,
  school_role           text CHECK (school_role IN ('Teacher','Head Teacher','Deputy Head Teacher','Director of Studies','Other')),

  -- B. school
  school_name           text NOT NULL CHECK (length(school_name) BETWEEN 1 AND 200),
  school_code           text NOT NULL CHECK (length(school_code) BETWEEN 1 AND 30),
  school_code_normalized text NOT NULL,
  school_name_normalized text NOT NULL,
  school_type           text CHECK (school_type IN ('Public','Government Aided','Private')),
  province_id           uuid NOT NULL REFERENCES provinces (id),
  district_id           uuid NOT NULL REFERENCES districts (id),
  sector_id             uuid REFERENCES sectors (id),
  sector_name_raw       text,            -- legacy free-text sector that could not be matched
  school_bank_name      text,
  school_bank_account   text,

  -- C. head teacher (separate from the registering contact and the maths teacher)
  head_teacher_first_name text,
  head_teacher_last_name  text,
  head_teacher_email      text,
  head_teacher_phone      text,

  -- D. mathematics teacher
  mathematics_teacher_first_name text,
  mathematics_teacher_last_name  text,
  mathematics_teacher_email      text,
  mathematics_teacher_phone      text,
  test_delivery_email            text,   -- deliberately separate from mathematics_teacher_email
  teacher_bank_name              text,
  mathematics_teacher_account_number text,

  -- E. estimates
  students_p5_p6        integer CHECK (students_p5_p6 BETWEEN 0 AND 100000),
  students_s1_s3        integer CHECK (students_s1_s3 BETWEEN 0 AND 100000),
  students_s4_s5        integer CHECK (students_s4_s5 BETWEEN 0 AND 100000),
  total_estimated_students integer GENERATED ALWAYS AS
    (COALESCE(students_p5_p6, 0) + COALESCE(students_s1_s3, 0) + COALESCE(students_s4_s5, 0)) STORED,

  -- F. free text
  questions_comments_concerns_feedback text CHECK (length(questions_comments_concerns_feedback) <= 5000),
  additional_information               text CHECK (length(additional_information) <= 5000),

  -- G. system
  is_legacy             boolean NOT NULL DEFAULT false,   -- imported from the old Google Sheet
  legacy_raw            jsonb,                            -- original row, kept verbatim
  idempotency_key       text UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint   text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- District must belong to the province, sector to the district (composite FKs).
  FOREIGN KEY (district_id, province_id) REFERENCES districts (id, province_id),
  FOREIGN KEY (sector_id, district_id)   REFERENCES sectors (id, district_id),

  -- Every required field is mandatory for new registrations; legacy rows keep the
  -- gaps of the old form and are never filled with invented values.
  CONSTRAINT new_registration_required_fields CHECK (
    is_legacy OR (
      first_name IS NOT NULL AND last_name IS NOT NULL AND email_address IS NOT NULL
      AND phone_contact IS NOT NULL AND school_role IS NOT NULL AND school_type IS NOT NULL
      AND sector_id IS NOT NULL
      AND head_teacher_first_name IS NOT NULL AND head_teacher_last_name IS NOT NULL
      AND head_teacher_email IS NOT NULL AND head_teacher_phone IS NOT NULL
      AND mathematics_teacher_first_name IS NOT NULL AND mathematics_teacher_last_name IS NOT NULL
      AND mathematics_teacher_email IS NOT NULL AND mathematics_teacher_phone IS NOT NULL
      AND test_delivery_email IS NOT NULL
      AND students_p5_p6 IS NOT NULL AND students_s1_s3 IS NOT NULL AND students_s4_s5 IS NOT NULL
    )
  )
);
CREATE INDEX school_registrations_edition_status_idx ON school_registrations (competition_edition_id, status);
CREATE INDEX school_registrations_created_idx ON school_registrations (created_at DESC, id);
CREATE INDEX school_registrations_school_idx ON school_registrations (school_id);
CREATE INDEX school_registrations_location_idx ON school_registrations (province_id, district_id, sector_id);
CREATE INDEX school_registrations_code_idx ON school_registrations (competition_edition_id, school_code_normalized);
CREATE INDEX school_registrations_name_idx ON school_registrations (competition_edition_id, school_name_normalized, district_id);
CREATE INDEX school_registrations_fingerprint_idx ON school_registrations (request_fingerprint, created_at DESC);
CREATE INDEX school_registrations_email_idx ON school_registrations (lower(email_address));
CREATE INDEX school_registrations_school_name_lower_idx ON school_registrations (lower(school_name));
CREATE TRIGGER school_registrations_updated BEFORE UPDATE ON school_registrations
  FOR EACH ROW EXECUTE FUNCTION rof_set_updated_at();

-- ---------------------------------------------------------------------------
-- Administrators
-- ---------------------------------------------------------------------------
CREATE TABLE admin_users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name        text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('viewer','admin','finance','super_admin')),
  is_active        boolean NOT NULL DEFAULT true,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  token_version    integer NOT NULL DEFAULT 0,   -- bump to revoke all issued tokens
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_users_updated BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION rof_set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit trail (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid,
  actor_label  text NOT NULL,               -- admin email, or 'public'
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  changes      jsonb,                       -- sensitive values are never stored here
  ip_address   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION rof_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION rof_audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION rof_audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Row-level security: enabled with NO policies, so the Supabase anon/authenticated
-- roles (and the public PostgREST API) can read or write nothing. Only the backend,
-- connecting with the table-owner/service role, touches these tables.
-- ---------------------------------------------------------------------------
ALTER TABLE competition_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provinces            ENABLE ROW LEVEL SECURITY;
ALTER TABLE districts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sectors              ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools              ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON competition_editions, provinces, districts, sectors, schools, school_registrations, admin_users, audit_log FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE audit_log_id_seq FROM %I', r);
    END IF;
  END LOOP;
END $$;
