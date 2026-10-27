import type { Db } from "./db.js";
import { LocationService, normKey } from "./locations.js";
import { parseCsv } from "./legacyImport.js";
import { SCHOOL_TYPES } from "./validation.js";

/**
 * Columns (header row required, any order): school_name, province, district, plus optional
 * sector, cell, school_code, school_type. A row without a sector is a district-level entry (offered for
 * every sector of that district). Codes are digits (as on the form) and kept as text.
 */
export interface DirectoryImportReport {
  total: number; created: number; updated: number; unchanged: number; skipped: { line: number; reason: string }[];
}

interface Existing {
  id: string; name: string; school_code: string | null; school_type: string | null;
  district_id: string; sector_id: string | null; cell_id: string | null;
}

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

  const seenCodes = new Set<string>();
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
    if (code !== null) {
      if (seenCodes.has(code.toLowerCase())) { report.skipped.push({ line, reason: "duplicate school_code in file" }); continue; }
      seenCodes.add(code.toLowerCase());
    }
    const typeRaw = col(r, "school_type");
    const type = typeRaw && (SCHOOL_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : null;
    const nameKey = normKey(name);

    // Match an existing entry by code when there is one, otherwise by place + name.
    const existing = (await db.query<Existing>(
      code !== null
        ? "SELECT id, name, school_code, school_type, district_id, sector_id, cell_id FROM school_directory WHERE school_code_normalized = $1"
        : `SELECT id, name, school_code, school_type, district_id, sector_id, cell_id FROM school_directory
           WHERE district_id = $1 AND sector_id IS NOT DISTINCT FROM $2 AND cell_id IS NOT DISTINCT FROM $3 AND name_normalized = $4`,
      code !== null ? [code.toLowerCase()] : [place.district_id, place.sector_id, place.cell_id, nameKey])).rows[0];

    if (existing) {
      const same = existing.name === name && existing.district_id === place.district_id && existing.sector_id === place.sector_id
        && existing.cell_id === place.cell_id && existing.school_type === type && (code === null || existing.school_code === code);
      if (same) { report.unchanged++; continue; }
      if (apply) {
        await db.query(
          `UPDATE school_directory SET name=$2, name_normalized=$3, district_id=$4, sector_id=$5, cell_id=$6, school_type=$7,
             school_code = COALESCE($8, school_code), school_code_normalized = COALESCE($9, school_code_normalized), source=$10, is_active=true
           WHERE id=$1`,
          [existing.id, name, nameKey, place.district_id, place.sector_id, place.cell_id, type, code, code?.toLowerCase() ?? null, source]);
      }
      report.updated++;
      continue;
    }
    if (apply) {
      try {
        await db.query(
          `INSERT INTO school_directory (school_code, school_code_normalized, name, name_normalized, school_type, district_id, sector_id, cell_id, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [code, code?.toLowerCase() ?? null, name, nameKey, type, place.district_id, place.sector_id, place.cell_id, source]);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") { report.skipped.push({ line, reason: "same school already listed in this place" }); continue; }
        throw err;
      }
    }
    report.created++;
  }
  return report;
}
