/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDataset, LocationService } from "../src/locations.js";
import { importSchoolDirectoryCsv } from "../src/schoolDirectory.js";
import { createAdmin, loginAs, makeApp, validPayload } from "./helpers.js";
import type { Db } from "../src/db.js";

let app: FastifyInstance; let db: Db; let loc: LocationService;
let sectorId: string; let cellId: string; let otherCellId: string; let otherSectorId: string;
const ids: Record<string, string> = {};

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const post = (over: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload(over) as any });
const first = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0]!;

// Synthetic directory (not real schools).
const CSV = [
  "school_name,province,district,sector,cell,school_code,school_type",
  "Test Primary A,Kigali,Gasabo,Kinyinya,Gacuriro,001001,Public",
  "Test Primary B,Kigali City,Gasabo,Kinyinya,Gacuriro,,Public",           // no code on file → manual
  "Test Secondary C,Kigali,Gasabo,Kinyinya,,001003,Private",              // no cell in source
  "Elsewhere School,Kigali,Kicukiro,Gatenga,,001004,Public",
  "Bad Place,Atlantis,x,y,,001005,Public",
  "Bad Code,Kigali,Gasabo,Kinyinya,Gacuriro,12ab,Public",
  ",Kigali,Gasabo,Kinyinya,,,Public",
].join("\n");

beforeAll(async () => {
  ({ app, db } = await makeApp());
  loc = new LocationService(db); await loc.load();
  sectorId = (await first("SELECT s.id FROM sectors s JOIN districts d ON d.id=s.district_id WHERE s.name='Kinyinya' AND d.name='Gasabo'")).id;
  cellId = (await first("SELECT id FROM cells WHERE sector_id=$1 AND name='Gacuriro'", [sectorId])).id;
  otherCellId = (await first("SELECT id FROM cells WHERE sector_id=$1 AND name<>'Gacuriro' LIMIT 1", [sectorId])).id;
  otherSectorId = (await first("SELECT s.id FROM sectors s JOIN districts d ON d.id=s.district_id WHERE s.name='Gatenga' AND d.name='Kicukiro'")).id;
  const rep = await importSchoolDirectoryCsv(db, loc, CSV, "synthetic test list", true);
  expect(rep).toMatchObject({ total: 7, created: 4 });
  for (const n of ["Test Primary A", "Test Primary B", "Test Secondary C", "Elsewhere School"])
    ids[n] = (await first("SELECT id FROM school_directory WHERE name=$1", [n])).id;
});

describe("cell reference data", () => {
  it("has all 2,148 cells, each inside the correct sector", async () => {
    const ds = loadDataset();
    const total = ds.provinces.flatMap((p) => p.districts.flatMap((d) => d.sectors.flatMap((s) => s.cells ?? []))).length;
    expect(total).toBe(2148);
    expect((await first("SELECT count(*)::int n FROM cells")).n).toBe(2148);
    expect((await first("SELECT count(*)::int n FROM sectors s WHERE NOT EXISTS (SELECT 1 FROM cells c WHERE c.sector_id=s.id)")).n).toBe(0);
  });
  it("resolves province → district → sector → cell and rejects a cell from another sector", () => {
    expect(loc.resolve("Kigali", "Gasabo", "Kinyinya", "Gacuriro")).toMatchObject({ ok: true, value: { cell: "Gacuriro" } });
    expect(loc.resolve("Kigali", "Gasabo", "Kinyinya", "gacuriro").ok).toBe(true);
    expect(loc.resolve("Kigali", "Gasabo", "Kinyinya")).toMatchObject({ ok: true, value: { cell_id: null } });
    expect(loc.resolve("Kigali", "Gasabo", "Kinyinya", "Nowhere")).toMatchObject({ ok: false, errors: { cell: expect.any(String) } });
    const foreignCell = loc.cellsOf(otherSectorId)![0]!.name;
    expect(loc.resolve("Kigali", "Gasabo", "Kinyinya", foreignCell).ok).toBe(false);
  });
  it("round-trips every cell under its own sector", () => {
    for (const p of loc.tree()) for (const d of p.districts) for (const s of d.sectors)
      for (const c of loc.cellsOf(s.id)!) expect(loc.resolve(p.name, d.name, s.name, c.name).ok, `${d.name}/${s.name}/${c.name}`).toBe(true);
  });
  it("serves cells per sector and 404s for unknown sectors", async () => {
    const res = await get(`/api/locations/sectors/${sectorId}/cells`);
    expect(res.statusCode).toBe(200);
    expect(res.json().cells.map((c: any) => c.name)).toContain("Gacuriro");
    expect((await get("/api/locations/sectors/00000000-0000-0000-0000-000000000000/cells")).statusCode).toBe(404);
    expect((await get("/api/locations/sectors/nope/cells")).statusCode).toBe(404);
  });
  it("the database refuses a cell that belongs to a different sector", async () => {
    const reg = await post({ school_code: "880001" });
    const id = reg.json().registration.id;
    const foreign = loc.cellsOf(otherSectorId)![0]!.id;
    await expect(db.query("UPDATE school_registrations SET cell_id=$2 WHERE id=$1", [id, foreign])).rejects.toThrow(/foreign key/i);
  });
});

describe("directory import", () => {
  it("imports valid rows and reports skipped ones with reasons", async () => {
    const dry = await importSchoolDirectoryCsv(db, loc, CSV, "again", false);
    expect(dry).toMatchObject({ total: 7, created: 0, unchanged: 4 });
    expect(dry.skipped.map((s) => s.line)).toEqual([6, 7, 8]);
    expect(dry.skipped[1]!.reason).toMatch(/digits/);
  });
  it("is idempotent and updates changed rows", async () => {
    expect(await importSchoolDirectoryCsv(db, loc, CSV, "again", true)).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
    const changed = CSV.replace("Test Secondary C,Kigali,Gasabo,Kinyinya,,001003,Private", "Test Secondary C,Kigali,Gasabo,Kinyinya,,001003,Government Aided");
    expect(await importSchoolDirectoryCsv(db, loc, changed, "again", true)).toMatchObject({ updated: 1 });
    expect((await first("SELECT school_type t FROM school_directory WHERE school_code='001003'")).t).toBe("Government Aided");
  });
  it("never writes on a dry run and keeps leading zeros", async () => {
    const before = (await first("SELECT count(*)::int n FROM school_directory")).n;
    await importSchoolDirectoryCsv(db, loc, "school_name,province,district,sector,school_code\nNew One,Kigali,Gasabo,Kinyinya,000042", "x", false);
    expect((await first("SELECT count(*)::int n FROM school_directory")).n).toBe(before);
    expect((await first("SELECT school_code c FROM school_directory WHERE name='Test Primary A'")).c).toBe("001001");
  });
  it("requires the mandatory columns", async () => {
    await expect(importSchoolDirectoryCsv(db, loc, "school_name,province\nA,B", "x", false)).rejects.toThrow(/district/);
  });
});

describe("GET /api/schools (pick-list)", () => {
  it("lists schools of a sector with their codes, and offers manual entry", async () => {
    const res = await get(`/api/schools?sector_id=${sectorId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.manual_entry_allowed).toBe(true);
    expect(body.schools.map((s: any) => s.name)).toEqual(["Test Primary A", "Test Primary B", "Test Secondary C"]);
    expect(body.schools[0]).toMatchObject({ school_code: "001001", school_type: "Public", id: ids["Test Primary A"] });
    expect(body.schools[1].school_code).toBeNull();
    expect(Object.keys(body.schools[0]).sort()).toEqual(["cell_id", "id", "name", "school_code", "school_type", "sector_id"]);
  });
  it("narrows by cell (keeping schools with no cell on file) and by name", async () => {
    const inCell = (await get(`/api/schools?sector_id=${sectorId}&cell_id=${cellId}`)).json().schools.map((s: any) => s.name);
    expect(inCell).toEqual(["Test Primary A", "Test Primary B", "Test Secondary C"]);
    expect((await get(`/api/schools?sector_id=${sectorId}&cell_id=${otherCellId}`)).json().schools.map((s: any) => s.name)).toEqual(["Test Secondary C"]);
    expect((await get(`/api/schools?sector_id=${sectorId}&q=secondary`)).json().schools).toHaveLength(1);
    expect((await get(`/api/schools?sector_id=${sectorId}&q=%25`)).json().schools).toHaveLength(0);
    expect((await get(`/api/schools?sector_id=${otherSectorId}`)).json().schools.map((s: any) => s.name)).toEqual(["Elsewhere School"]);
  });
  it("validates parameters and hides inactive schools", async () => {
    expect((await get("/api/schools")).statusCode).toBe(422);
    expect((await get("/api/schools?sector_id=x")).statusCode).toBe(422);
    expect((await get(`/api/schools?sector_id=${sectorId}&cell_id=bad`)).statusCode).toBe(422);
    await db.query("UPDATE school_directory SET is_active=false WHERE id=$1", [ids["Test Secondary C"]]);
    expect((await get(`/api/schools?sector_id=${sectorId}`)).json().schools).toHaveLength(2);
    await db.query("UPDATE school_directory SET is_active=true WHERE id=$1", [ids["Test Secondary C"]]);
  });
});

describe("registration using the cascade", () => {
  const base = { province: "Kigali", district: "Gasabo", sector: "Kinyinya", cell: "Gacuriro" };

  it("auto-fills school name and code from the directory pick (client name/code not needed)", async () => {
    const res = await post({ ...base, directory_school_id: ids["Test Primary A"], school_name: undefined, school_code: undefined });
    expect(res.statusCode).toBe(201);
    const row = await first("SELECT r.school_name, r.school_code, r.directory_school_id, c.name AS cell FROM school_registrations r JOIN cells c ON c.id=r.cell_id WHERE r.id=$1", [res.json().registration.id]);
    expect(row).toEqual({ school_name: "Test Primary A", school_code: "001001", directory_school_id: ids["Test Primary A"], cell: "Gacuriro" });
  });
  it("uses the directory's name even if the client sent a different one, and ignores a matching code's spacing", async () => {
    const res = await post({ ...base, directory_school_id: ids["Test Primary A"], school_name: "Typo Name", school_code: " 001001 ", first_name: "Distinct" });
    expect(res.statusCode).toBe(201);
    expect((await first("SELECT school_name FROM school_registrations WHERE id=$1", [res.json().registration.id])).school_name).toBe("Test Primary A");
  });
  it("rejects a code that contradicts the selected school", async () => {
    const res = await post({ ...base, directory_school_id: ids["Test Primary A"], school_code: "999999" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields.school_code).toMatch(/does not match/);
  });
  it("requires a manually typed code when the selected school has none on file, and accepts it", async () => {
    const missing = await post({ ...base, directory_school_id: ids["Test Primary B"], school_code: undefined });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.fields.school_code).toMatch(/has no code/);
    const ok = await post({ ...base, directory_school_id: ids["Test Primary B"], school_code: "770077" });
    expect(ok.statusCode).toBe(201);
    expect((await first("SELECT school_name, school_code FROM school_registrations WHERE id=$1", [ok.json().registration.id]))).toEqual({ school_name: "Test Primary B", school_code: "770077" });
  });
  it("takes the cell from the directory when the client left it out", async () => {
    const res = await post({ province: "Kigali", district: "Gasabo", sector: "Kinyinya", directory_school_id: ids["Test Primary A"], school_code: undefined, school_name: undefined });
    expect(res.statusCode).toBe(201);
    expect((await first("SELECT cell_id FROM school_registrations WHERE id=$1", [res.json().registration.id])).cell_id).toBe(cellId);
  });
  it("rejects a directory school from another sector or cell, or an unknown / malformed id", async () => {
    let res = await post({ ...base, directory_school_id: ids["Elsewhere School"] });
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.directory_school_id).toMatch(/sector/);
    const cellName = (await first("SELECT name FROM cells WHERE id=$1", [otherCellId])).name;
    res = await post({ ...base, cell: cellName, directory_school_id: ids["Test Primary A"] });
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.directory_school_id).toMatch(/cell/);
    res = await post({ ...base, directory_school_id: "00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(422);
    res = await post({ ...base, directory_school_id: "not-a-uuid" });
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.directory_school_id).toBeDefined();
  });
  it("rejects an inactive directory school", async () => {
    await db.query("UPDATE school_directory SET is_active=false WHERE id=$1", [ids["Test Primary A"]]);
    expect((await post({ ...base, directory_school_id: ids["Test Primary A"] })).statusCode).toBe(422);
    await db.query("UPDATE school_directory SET is_active=true WHERE id=$1", [ids["Test Primary A"]]);
  });
  it("manual entry still works when the school is not listed: name and code are required", async () => {
    const ok = await post({ ...base, school_name: "Unlisted School", school_code: "123123" });
    expect(ok.statusCode).toBe(201);
    expect((await first("SELECT directory_school_id d FROM school_registrations WHERE id=$1", [ok.json().registration.id])).d).toBeNull();
    const no = await post({ ...base, school_name: undefined, school_code: undefined });
    expect(no.statusCode).toBe(422);
    expect(Object.keys(no.json().error.fields).sort()).toEqual(["school_code", "school_name"]);
  });
  it("cell is optional, but a wrong cell for the sector is rejected", async () => {
    expect((await post({ school_code: "555001" })).statusCode).toBe(201);
    const foreign = loc.cellsOf(otherSectorId)![0]!.name;
    const res = await post({ cell: foreign, school_code: "555002" });
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.cell).toBeDefined();
  });
  it("treats a repeated directory submission as the same request (idempotent)", async () => {
    const payload = { ...base, directory_school_id: ids["Test Secondary C"], school_code: undefined, school_name: undefined, first_name: "Repeat" };
    const a = await post(payload); const b = await post(payload);
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().registration.id).toBe(a.json().registration.id);
  });
});

describe("admin side of the cell", () => {
  let token: string; let regId: string;
  beforeAll(async () => {
    await createAdmin(db, "super_admin"); token = await loginAs(app, "super_admin@test.example");
    regId = (await post({ province: "Kigali", district: "Gasabo", sector: "Kinyinya", cell: "Gacuriro", school_code: "660001" })).json().registration.id;
  });
  const auth = () => ({ authorization: `Bearer ${token}` });

  it("returns the cell in detail/list, filters by it, and exports it", async () => {
    expect((await get(`/api/school-registrations/${regId}`, auth())).json().cell).toBe("Gacuriro");
    expect((await get("/api/school-registrations?cell=Gacuriro&q=660001", auth())).json().pagination.total).toBe(1);
    expect((await get(`/api/school-registrations?cell=${otherCellId}&q=660001`, auth())).json().pagination.total).toBe(0);
    const csv = (await get("/api/school-registrations/export?q=660001", auth())).body;
    expect(csv).toContain(",Sector,Cell,");
    expect(csv).toContain("Kinyinya,Gacuriro");
  });
  it("validates cell changes and clears the cell when the sector changes", async () => {
    const patch = (body: unknown) => app.inject({ method: "PATCH", url: `/api/school-registrations/${regId}`, payload: body as any, headers: auth() });
    expect((await patch({ cell: "Nowhere" })).statusCode).toBe(422);
    const other = loc.cellsOf(sectorId)!.find((c) => c.id === otherCellId)!.name;
    expect((await patch({ cell: other })).json().cell).toBe(other);
    expect((await patch({ cell: null })).json().cell).toBeNull();
    await patch({ cell: "Gacuriro" });
    const moved = await patch({ district: "Kicukiro", sector: "Gatenga" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ sector: "Gatenga", cell: null });
  });
});

describe("district-level directory entries (official lists carry no sector)", () => {
  const DISTRICT_CSV = [
    "school_name,province,district,sector,cell,school_code,school_type",
    "District Wide School One,Kigali,Gasabo,,,120001,",
    "District Wide School Two,Kigali City,Gasabo,,,120002,",
    "Same Name,Kigali,Gasabo,,,120003,",
    "Same Name,Kigali,Gasabo,,,120004,",            // same name, different official code: both kept
    "Other District School,Kigali,Kicukiro,,,130001,",
    "Orphan Cell,Kigali,Gasabo,,Gacuriro,120005,",   // cell without sector: rejected
  ].join("\n");
  const sectorOf = async (district: string, sector: string) =>
    (await first("SELECT s.id FROM sectors s JOIN districts d ON d.id=s.district_id WHERE s.name=$1 AND d.name=$2", [sector, district])).id;

  beforeAll(async () => {
    const rep = await importSchoolDirectoryCsv(db, loc, DISTRICT_CSV, "district list", true);
    expect(rep).toMatchObject({ created: 5, skipped: [{ line: 7, reason: expect.stringMatching(/cell given without a sector/) }] });
  });

  it("offers district-level schools for every sector of the district, after the sector's own schools", async () => {
    for (const sector of ["Kinyinya", "Kimironko", "Remera"]) {
      const names = (await get(`/api/schools?sector_id=${await sectorOf("Gasabo", sector)}`)).json().schools.map((s: any) => s.name);
      expect(names, sector).toEqual(expect.arrayContaining(["District Wide School One", "District Wide School Two"]));
    }
    const inKinyinya = (await get(`/api/schools?sector_id=${sectorId}`)).json().schools.map((s: any) => s.name);
    expect(inKinyinya.slice(0, 3)).toEqual(["Test Primary A", "Test Primary B", "Test Secondary C"]); // sector-specific first
    expect(inKinyinya).not.toContain("Other District School"); // other district never leaks in
  });
  it("keeps two schools with the same name when their codes differ", async () => {
    const same = (await get(`/api/schools?sector_id=${sectorId}&q=Same%20Name`)).json().schools;
    expect(same.map((s: any) => s.school_code).sort()).toEqual(["120003", "120004"]);
  });
  it("auto-fills code for a district-level school chosen in any sector of its district", async () => {
    const id = (await first("SELECT id FROM school_directory WHERE school_code='120001'")).id;
    const res = await post({ province: "Kigali", district: "Gasabo", sector: "Kimironko", directory_school_id: id, school_name: undefined, school_code: undefined });
    expect(res.statusCode).toBe(201);
    expect(await first("SELECT school_name, school_code, directory_school_id FROM school_registrations WHERE id=$1", [res.json().registration.id]))
      .toEqual({ school_name: "District Wide School One", school_code: "120001", directory_school_id: id });
  });
  it("rejects a district-level school chosen in a different district", async () => {
    const id = (await first("SELECT id FROM school_directory WHERE school_code='120001'")).id;
    const res = await post({ province: "Kigali", district: "Kicukiro", sector: "Gatenga", directory_school_id: id, school_name: undefined, school_code: undefined });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields.directory_school_id).toMatch(/district/);
  });
  it("lets a registrant type the school when it is not listed, and admins can find those", async () => {
    const res = await post({ province: "Kigali", district: "Gasabo", sector: "Remera", school_name: "Brand New Academy", school_code: "990011" });
    expect(res.statusCode).toBe(201);
    await createAdmin(db, "admin");
    const t = await loginAs(app, "admin@test.example");
    const manual = await get("/api/school-registrations?in_directory=false&q=Brand", { authorization: `Bearer ${t}` });
    expect(manual.json().pagination.total).toBe(1);
    const picked = await get("/api/school-registrations?in_directory=true&q=Brand", { authorization: `Bearer ${t}` });
    expect(picked.json().pagination.total).toBe(0);
  });
  it("database refuses a cell without a sector and a sector outside the entry's district", async () => {
    const gasabo = (await first("SELECT id FROM districts WHERE name='Gasabo'")).id;
    await expect(db.query("INSERT INTO school_directory (name, name_normalized, district_id, cell_id) VALUES ('x','x',$1,$2)", [gasabo, cellId])).rejects.toThrow(/cell_needs_sector/);
    await expect(db.query("INSERT INTO school_directory (name, name_normalized, district_id, sector_id) VALUES ('y','y',$1,$2)", [gasabo, otherSectorId])).rejects.toThrow(/foreign key/i);
  });
});
