-- Official school lists (NESA exam results) give a school's code, name and district but no sector or cell.
-- Directory entries therefore belong to a district, and optionally narrow to a sector and a cell.
-- A school with no sector is offered for every sector of its district.

ALTER TABLE school_directory ADD COLUMN district_id uuid REFERENCES districts (id);
UPDATE school_directory sd SET district_id = s.district_id FROM sectors s WHERE s.id = sd.sector_id;
ALTER TABLE school_directory ALTER COLUMN district_id SET NOT NULL;
ALTER TABLE school_directory ALTER COLUMN sector_id DROP NOT NULL;

ALTER TABLE school_directory
  ADD CONSTRAINT school_directory_sector_in_district_fk FOREIGN KEY (sector_id, district_id) REFERENCES sectors (id, district_id);
ALTER TABLE school_directory
  ADD CONSTRAINT school_directory_cell_needs_sector CHECK (cell_id IS NULL OR sector_id IS NOT NULL);

-- Two schools may share a name within a district when their official codes differ, so name uniqueness
-- is only enforced for entries that have no code.
DROP INDEX school_directory_name_uq;
CREATE UNIQUE INDEX school_directory_name_uq ON school_directory (
  district_id,
  COALESCE(sector_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(cell_id, '00000000-0000-0000-0000-000000000000'::uuid),
  name_normalized
) WHERE school_code_normalized IS NULL;

DROP INDEX school_directory_sector_idx;
CREATE INDEX school_directory_district_idx ON school_directory (district_id, sector_id, cell_id) WHERE is_active;
