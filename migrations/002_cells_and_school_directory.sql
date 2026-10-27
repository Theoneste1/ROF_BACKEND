-- Adds the Cell level of Rwanda's administrative geography and a school directory used to
-- pre-fill school names and codes on the registration form. Additive only.

CREATE TABLE cells (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  sector_id  uuid NOT NULL REFERENCES sectors (id),
  name       text NOT NULL,
  UNIQUE (sector_id, name),
  UNIQUE (id, sector_id)
);
CREATE INDEX cells_sector_idx ON cells (sector_id);

-- Reference list of known schools, loaded by `npm run import:schools` from an official source.
-- A school may have no code in the source: the form then asks the user to type it.
CREATE TABLE school_directory (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_code             text,
  school_code_normalized  text,
  name                    text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_normalized         text NOT NULL,
  school_type             text CHECK (school_type IN ('Public','Government Aided','Private')),
  sector_id               uuid NOT NULL REFERENCES sectors (id),
  cell_id                 uuid,
  source                  text,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cell_id, sector_id) REFERENCES cells (id, sector_id),
  CHECK ((school_code IS NULL) = (school_code_normalized IS NULL))
);
CREATE UNIQUE INDEX school_directory_code_uq ON school_directory (school_code_normalized) WHERE school_code_normalized IS NOT NULL;
CREATE UNIQUE INDEX school_directory_name_uq ON school_directory (sector_id, COALESCE(cell_id, '00000000-0000-0000-0000-000000000000'::uuid), name_normalized);
CREATE INDEX school_directory_sector_idx ON school_directory (sector_id, cell_id) WHERE is_active;
CREATE TRIGGER school_directory_updated BEFORE UPDATE ON school_directory
  FOR EACH ROW EXECUTE FUNCTION rof_set_updated_at();

-- Registrations remember the cell and which directory entry (if any) was picked.
ALTER TABLE school_registrations ADD COLUMN cell_id uuid;
ALTER TABLE school_registrations ADD COLUMN directory_school_id uuid REFERENCES school_directory (id);
ALTER TABLE school_registrations
  ADD CONSTRAINT school_registrations_cell_fk FOREIGN KEY (cell_id, sector_id) REFERENCES cells (id, sector_id);
CREATE INDEX school_registrations_directory_idx ON school_registrations (directory_school_id);

ALTER TABLE cells            ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_directory ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON cells, school_directory FROM %I', r);
    END IF;
  END LOOP;
END $$;
