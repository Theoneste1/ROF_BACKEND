import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createEdition, freshDb } from "./helpers.js";
import { LocationService, loadDataset } from "../src/locations.js";
import { importSchoolDirectoryCsv } from "../src/schoolDirectory.js";
import { parseCsv } from "../src/csvParse.js";

const FILE = new URL("../data/school-directory.csv", import.meta.url);
const NESA = new URL("../data/schools-nesa-2024-25.csv", import.meta.url);

/**
 * Guards data/school-directory.csv, built by scripts/merge-school-sources.mjs from the NESA 2024/25
 * exam-result lists and the school list supplied by ROF.
 * Columns: 0 name, 1 province, 2 district, 3 sector, 4 cell, 5 code, 6 type.
 */
describe("data/school-directory.csv", () => {
  const rows = parseCsv(fs.readFileSync(FILE, "utf8")).slice(1);
  const ds = loadDataset();
  const tree = new Map(ds.provinces.flatMap((p) => p.districts.map((d) => [d.name, { province: p.name, sectors: new Map(d.sectors.map((s) => [s.name, new Set((s.cells ?? []).map((c) => c.name))])) }] as const)));

  it("has 4,190 schools, each with a unique 6-digit code and a name", () => {
    expect(rows).toHaveLength(4190);
    for (const r of rows) {
      expect(r[5], r.join("|")).toMatch(/^\d{6}$/);
      expect(r[0]!.trim().length).toBeGreaterThan(1);
    }
    expect(new Set(rows.map((r) => r[5])).size).toBe(rows.length);
  });
  it("covers all 30 districts under the right provinces", () => {
    const seen = new Set<string>();
    for (const r of rows) { expect(tree.get(r[2]!)?.province, r[2]).toBe(r[1]); seen.add(r[2]!); }
    expect(seen.size).toBe(30);
  });
  it("every sector belongs to its district and every cell to its sector (names exactly as in the location data)", () => {
    let withSector = 0, withCell = 0;
    for (const r of rows) {
      if (!r[3]) { expect(r[4], `cell without sector: ${r[5]}`).toBe(""); continue; }
      withSector++;
      const cells = tree.get(r[2]!)!.sectors.get(r[3]);
      expect(cells, `${r[2]}/${r[3]} (${r[5]})`).toBeDefined();
      if (r[4]) { withCell++; expect(cells!.has(r[4]), `${r[2]}/${r[3]}/${r[4]} (${r[5]})`).toBe(true); }
    }
    expect(withSector).toBe(1974);
    expect(withCell).toBe(1631);
  });
  it("school types are only the three the form offers, or empty", () => {
    for (const r of rows) expect(["", "Public", "Government Aided", "Private"]).toContain(r[6]);
    expect(rows.filter((r) => r[6]).length).toBe(1974); // every school with a sector also has a type
  });
  it("code prefix is consistent with the district for every school (same first two digits ⇒ same district)", () => {
    const byPrefix = new Map<string, Set<string>>();
    for (const r of rows) byPrefix.set(r[5]!.slice(0, 2), (byPrefix.get(r[5]!.slice(0, 2)) ?? new Set()).add(r[2]!));
    expect(byPrefix.size).toBe(30);
    for (const [p, s] of byPrefix) expect(s.size, p).toBe(1);
  });
  it("contains every school of the NESA list (the merge only adds and enriches)", () => {
    const merged = new Map(rows.map((r) => [r[5]!, r]));
    const nesa = parseCsv(fs.readFileSync(NESA, "utf8")).slice(1);
    expect(nesa).toHaveLength(4004);
    for (const r of nesa) {
      const m = merged.get(r[5]!);
      expect(m, r[5]).toBeDefined();
      expect(m![2]).toBe(r[2]); // same district
      expect(m![0]).toBe(r[0]); // NESA name kept
    }
  });
  it("imports cleanly into the directory with nothing skipped, and re-importing changes nothing", async () => {
    const db = await freshDb();
    const loc = new LocationService(db); await loc.load();
    const csv = fs.readFileSync(FILE, "utf8");
    const first = await importSchoolDirectoryCsv(db, loc, csv, "NESA 2024/25 + ROF list", true);
    expect(first).toMatchObject({ total: 4190, created: 4190, updated: 0, skipped: [] });
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM school_directory WHERE sector_id IS NOT NULL")).rows[0]!.n).toBe(1974);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM school_directory WHERE cell_id IS NOT NULL")).rows[0]!.n).toBe(1631);
    expect(await importSchoolDirectoryCsv(db, loc, csv, "again", true)).toMatchObject({ created: 0, updated: 0, unchanged: 4190 });
    void createEdition;
  });
});

describe("location data corrections and aliases", () => {
  it("uses the official spellings Rilima (Bugesera) and Rugengabari (Burera)", () => {
    const names = (district: string) => loadDataset().provinces.flatMap((p) => p.districts).find((d) => d.name === district)!.sectors.map((s) => s.name);
    expect(names("Bugesera")).toContain("Rilima");
    expect(names("Bugesera")).not.toContain("Ririma");
    expect(names("Burera")).toContain("Rugengabari");
    expect(names("Burera")).not.toContain("Rugendabari");
    expect(names("Muhanga")).toContain("Rugendabari"); // the real Rugendabari is in Muhanga
  });
  it("accepts alternative spellings from official school lists via the alias table", async () => {
    const db = await freshDb();
    const loc = new LocationService(db); await loc.load();
    expect(loc.resolve("Kigali", "Nyarugenge", "Mageregere")).toMatchObject({ ok: true, value: { sector: "Mageragere" } });
    expect(loc.resolve("Eastern", "Kirehe", "Mahama", "Munini")).toMatchObject({ ok: true, value: { cell: "Umunini" } });
    expect(loc.resolve("Kigali", "Nyarugenge", "Nowhere").ok).toBe(false);
  });
});
