import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Queryable } from "./db.js";

interface Dataset {
  provinces: { code: string; name: string; districts: { code: string; name: string; sectors: { code: string; name: string; cells?: { code: string; name: string }[] }[] }[] }[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
export function loadDataset(): Dataset {
  for (const rel of ["../data/rwanda-locations.json", "../../data/rwanda-locations.json"]) {
    const p = path.resolve(here, rel);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as Dataset;
  }
  throw new Error("data/rwanda-locations.json not found");
}

/**
 * Idempotently loads the reference dataset. Existing rows are matched on their stable
 * `code` and only renamed, never deleted, so registrations that reference them stay valid.
 */
export async function seedLocations(db: Db, dataset = loadDataset()): Promise<{ provinces: number; districts: number; sectors: number; cells: number }> {
  return db.transaction(async (tx) => {
    let d = 0, s = 0, c = 0;
    for (const p of dataset.provinces) {
      const pr = await tx.query<{ id: string }>(
        `INSERT INTO provinces (code, name) VALUES ($1, $2)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [p.code, p.name]);
      const provinceId = pr.rows[0]!.id;
      for (const dist of p.districts) {
        const dr = await tx.query<{ id: string }>(
          `INSERT INTO districts (code, province_id, name) VALUES ($1, $2, $3)
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [dist.code, provinceId, dist.name]);
        d++;
        const districtId = dr.rows[0]!.id;
        for (const sec of dist.sectors) {
          const sr = await tx.query<{ id: string }>(
            `INSERT INTO sectors (code, district_id, name) VALUES ($1, $2, $3)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [sec.code, districtId, sec.name]);
          s++;
          for (const cell of sec.cells ?? []) {
            await tx.query(
              `INSERT INTO cells (code, sector_id, name) VALUES ($1, $2, $3)
               ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`, [cell.code, sr.rows[0]!.id, cell.name]);
            c++;
          }
        }
      }
    }
    return { provinces: dataset.provinces.length, districts: d, sectors: s, cells: c };
  });
}

interface Aliases { sectors: Record<string, string>; cells: Record<string, string> }
export function loadAliases(): Aliases {
  for (const rel of ["../data/location-aliases.json", "../../data/location-aliases.json"]) {
    const p = path.resolve(here, rel);
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Aliases>;
      return { sectors: j.sectors ?? {}, cells: j.cells ?? {} };
    }
  }
  return { sectors: {}, cells: {} };
}

/** Lower-case, accent-stripped, letters/digits only. */
export const normKey = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Kigali", "Kigali City", "City of Kigali", "Northern Province" -> kigali / northern ... */
const provinceKey = (s: string): string => normKey(s).replace(/cityof|province|city/g, "");

export interface ResolvedLocation {
  province_id: string; province: string;
  district_id: string; district: string;
  sector_id: string; sector: string;
  cell_id: string | null; cell: string | null;
}

interface Cell { id: string; name: string }
interface Sec { id: string; name: string; cells: Map<string, Cell> }
interface Dist { id: string; name: string; sectors: Map<string, Sec> }
interface Prov { id: string; name: string; districts: Map<string, Dist> }

export class LocationService {
  private provinces = new Map<string, Prov>();
  private readonly aliases = loadAliases();
  constructor(private readonly db: Queryable) {}

  async load(): Promise<void> {
    const provinces = new Map<string, Prov>();
    const byDistrictId = new Map<string, Dist>();
    const bySectorId = new Map<string, Sec>();
    const provById = new Map<string, Prov>();
    for (const r of (await this.db.query<{ id: string; name: string }>("SELECT id, name FROM provinces")).rows) {
      const p: Prov = { id: r.id, name: r.name, districts: new Map() };
      provinces.set(provinceKey(r.name), p); provById.set(r.id, p);
    }
    for (const r of (await this.db.query<{ id: string; name: string; province_id: string }>("SELECT id, name, province_id FROM districts")).rows) {
      const d: Dist = { id: r.id, name: r.name, sectors: new Map() };
      provById.get(r.province_id)!.districts.set(normKey(r.name), d); byDistrictId.set(r.id, d);
    }
    for (const r of (await this.db.query<{ id: string; name: string; district_id: string }>("SELECT id, name, district_id FROM sectors")).rows) {
      const sec: Sec = { id: r.id, name: r.name, cells: new Map() };
      byDistrictId.get(r.district_id)!.sectors.set(normKey(r.name), sec); bySectorId.set(r.id, sec);
    }
    for (const r of (await this.db.query<{ id: string; name: string; sector_id: string }>("SELECT id, name, sector_id FROM cells")).rows) {
      bySectorId.get(r.sector_id)!.cells.set(normKey(r.name), { id: r.id, name: r.name });
    }
    this.provinces = provinces;
  }

  /** Validates the hierarchy; returns per-field errors on any mismatch. */
  resolve(province: string, district: string, sector: string, cell?: string | null): { ok: true; value: ResolvedLocation } | { ok: false; errors: Record<string, string> } {
    const p = this.provinces.get(provinceKey(province));
    if (!p) return { ok: false, errors: { province: `"${province}" is not a province of Rwanda.` } };
    const d = p.districts.get(normKey(district));
    if (!d) return { ok: false, errors: { district: `"${district}" is not a district of ${p.name}.` } };
    const s = d.sectors.get(normKey(sector)) ?? d.sectors.get(normKey(this.aliases.sectors[`${normKey(d.name)}|${normKey(sector)}`] ?? ""));
    if (!s) return { ok: false, errors: { sector: `"${sector}" is not a sector of ${d.name} district.` } };
    let c: Cell | undefined;
    if (cell) {
      c = s.cells.get(normKey(cell)) ?? s.cells.get(normKey(this.aliases.cells[`${normKey(d.name)}|${normKey(s.name)}|${normKey(cell)}`] ?? ""));
      if (!c) return { ok: false, errors: { cell: `"${cell}" is not a cell of ${s.name} sector.` } };
    }
    return { ok: true, value: { province_id: p.id, province: p.name, district_id: d.id, district: d.name, sector_id: s.id, sector: s.name, cell_id: c?.id ?? null, cell: c?.name ?? null } };
  }

  /** Validates province + district only (for directory entries that have no sector). */
  resolveDistrict(province: string, district: string): { ok: true; value: { province_id: string; district_id: string } } | { ok: false; errors: Record<string, string> } {
    const p = this.provinces.get(provinceKey(province));
    if (!p) return { ok: false, errors: { province: `"${province}" is not a province of Rwanda.` } };
    const d = p.districts.get(normKey(district));
    if (!d) return { ok: false, errors: { district: `"${district}" is not a district of ${p.name}.` } };
    return { ok: true, value: { province_id: p.id, district_id: d.id } };
  }

  /** Province id for any accepted spelling ("Kigali", "Southern Province", ...), or null. */
  provinceId(name: string): string | null {
    return this.provinces.get(provinceKey(name))?.id ?? null;
  }

  /** Cells of one sector (for the cell dropdown), or null if the sector id is unknown. */
  cellsOf(sectorId: string): { id: string; name: string }[] | null {
    for (const p of this.provinces.values()) for (const d of p.districts.values()) for (const s of d.sectors.values())
      if (s.id === sectorId) return [...s.cells.values()].map((c) => ({ id: c.id, name: c.name }));
    return null;
  }

  /** Public reference tree for dropdowns (down to sectors; cells are loaded per sector). */
  tree() {
    return [...this.provinces.values()].map((p) => ({
      id: p.id, name: p.name,
      districts: [...p.districts.values()].map((d) => ({
        id: d.id, name: d.name,
        sectors: [...d.sectors.values()].map((s) => ({ id: s.id, name: s.name })),
      })),
    }));
  }
}
