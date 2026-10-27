import type { Db } from "./db.js";
import { LocationService, normKey } from "./locations.js";
import { parseCsv } from "./legacyImport.js";
import { SCHOOL_TYPES } from "./validation.js";

/**
 * Columns (header row required, any order): school_name, province, district, plus optional
 * sector, cell, school_code, school_type. A row without a sector is a district-level entry (offered for
 * every sector of that district). Codes are digits (as on the form) and kept as text.
 *
 * The existing directory is read once and every decision is made in memory; new rows are inserted in batches.
 * (One query per row is unusably slow against a remote database such as Supabase.)
 */
export interface DirectoryImportReport {
  total: number; created: number; updated: number; unchanged: number; skipped: { line: number; reason: string }[];
}

interface Existing {
  id: string; name: string; school_code: string | null; school_type: string | null;
  district_id: string; sector_id: string | null; cell_id: string | null; name_normalized: string;
}
interface NewRow {
  code: string | null; codeKey: string | null; name: string; nameKey: string; type: string | null;
  districtId: string; sectorId: string | null; cellId: string | null;
}

const BATCH = 500;
const placeKey = (district: string, sector: string | null, cell: string | null, nameKey: string) => `${district}|${sector ?? ""}|${cell ?? ""}|${nameKey}`;

export async function importSchoolDirectoryCsv(
  db: Db, locations: LocationService, csv: string, source: string, apply: boolean,
): Promise<DirectoryImportReport> {
  const rows = parseCsv(csv);
  const report: DirectoryImportReport = { total: Math.max(rows.length - 1, 0), created: 0, updated: 0, unchanged: 0, skipped: [] };
  if (rows.length < 2) return report;
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  for (const need of ["school_name", "province", "district"])
    if (!header.includes(need)) throw new Error(`CSV is missing the "${need}" column.`);
  const col = (r: string[], name: string): string | null => {
    const i = header.indexOf(name);
    const v = i >= 0 ? (r[i] ?? "").replace(/\s+/g, " ").trim() : "";
    return v === "" ? null : v;
  };

  // Read the current directory once.
  const existing = (await db.query<Existing>(
    "SELECT id, name, name_normalized, school_code, school_type, district_id, sector_id, cell_id FROM school_directory")).rows;
  const byCode = new Map(existing.filter((e) => e.school_code).map((e) => [e.school_code!.toLowerCase(), e]));
  const byPlace = new Map(existing.filter((e) => !e.school_code).map((e) => [placeKey(e.district_id, e.sector_id, e.cell_id, e.name_normalized), e]));

  const seenCodes = new Set<string>();
  const seenPlaces = new Set<string>();
  const inserts: NewRow[] = [];
  const updates: { id: string; row: NewRow }[] = [];

  for (let n = 1; n < rows.length; n++) {
    const r = rows[n]!, line = n + 1;
    const name = col(r, "school_name");
    if (!name || name.length > 200) { report.skipped.push({ line, reason: "missing or too long school_name" }); continue; }

    const sector = col(r, "sector"), cell = col(r, "cell");
    let place: { district_id: string; sector_id: string | null; cell_id: string | null };
    if (sector) {
      const loc = locations.resolve(col(r, "province") ?? "", col(r, "district") ?? "", sector, cell);
      if (!loc.ok) { report.skipped.push({ line, reason: Object.values(loc.errors)[0]! }); continue; }
      place = { district_id: loc.value.district_id, sector_id: loc.value.sector_id, cell_id: loc.value.cell_id };
    } else {
      if (cell) { report.skipped.push({ line, reason: "cell given without a sector" }); continue; }
      const loc = locations.resolveDistrict(col(r, "province") ?? "", col(r, "district") ?? "");
      if (!loc.ok) { report.skipped.push({ line, reason: Object.values(loc.errors)[0]! }); continue; }
      place = { district_id: loc.value.district_id, sector_id: null, cell_id: null };
    }

    const code = col(r, "school_code");
    if (code !== null && !/^\d{1,20}$/.test(code)) { report.skipped.push({ line, reason: "school_code must be digits only" }); continue; }
    const codeKey = code?.toLowerCase() ?? null;
    if (codeKey !== null) {
      if (seenCodes.has(codeKey)) { report.skipped.push({ line, reason: "duplicate school_code in file" }); continue; }
      seenCodes.add(codeKey);
    }
    const typeRaw = col(r, "school_type");
    const type = typeRaw && (SCHOOL_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : null;
    const nameKey = normKey(name);
    const row: NewRow = { code, codeKey, name, nameKey, type, districtId: place.district_id, sectorId: place.sector_id, cellId: place.cell_id };

    const match = codeKey !== null ? byCode.get(codeKey) : byPlace.get(placeKey(place.district_id, place.sector_id, place.cell_id, nameKey));
    if (match) {
      const same = match.name === name && match.district_id === place.district_id && match.sector_id === place.sector_id
        && match.cell_id === place.cell_id && match.school_type === type && (code === null || match.school_code === code);
      if (same) report.unchanged++; else { updates.push({ id: match.id, row }); report.updated++; }
      continue;
    }
    if (codeKey === null) {
      // Entries without a code are unique per place + name.
      const pk = placeKey(place.district_id, place.sector_id, place.cell_id, nameKey);
      if (seenPlaces.has(pk)) { report.skipped.push({ line, reason: "same school already listed in this place" }); continue; }
      seenPlaces.add(pk);
    }
    inserts.push(row);
    report.created++;
  }

  if (!apply) return report;

  await db.transaction(async (tx) => {
    for (const { id, row } of updates) {
      await tx.query(
        `UPDATE school_directory SET name=$2, name_normalized=$3, district_id=$4, sector_id=$5, cell_id=$6, school_type=$7,
           school_code = COALESCE($8, school_code), school_code_normalized = COALESCE($9, school_code_normalized), source=$10, is_active=true
         WHERE id=$1`,
        [id, row.name, row.nameKey, row.districtId, row.sectorId, row.cellId, row.type, row.code, row.codeKey, source]);
    }
    for (let i = 0; i < inserts.length; i += BATCH) {
      const b = inserts.slice(i, i + BATCH);
      await tx.query(
        `INSERT INTO school_directory (school_code, school_code_normalized, name, name_normalized, school_type, district_id, sector_id, cell_id, source)
         SELECT c, ck, n, nk, t, d, s, ce, $9 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::uuid[], $8::uuid[]) AS u(c, ck, n, nk, t, d, s, ce)`,
        [b.map((x) => x.code), b.map((x) => x.codeKey), b.map((x) => x.name), b.map((x) => x.nameKey), b.map((x) => x.type),
          b.map((x) => x.districtId), b.map((x) => x.sectorId), b.map((x) => x.cellId), source]);
    }
  });
  return report;
}
