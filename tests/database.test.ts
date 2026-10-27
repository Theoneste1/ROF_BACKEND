import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { pgliteDb, freshDb, createEdition } from "./helpers.js";
import { runMigrations, migrationsDir } from "../src/migrate.js";
import { LocationService, loadDataset, seedLocations } from "../src/locations.js";
import type { Db } from "../src/db.js";

describe("reference location dataset", () => {
  const ds = loadDataset();
  it("has Rwanda's 5 provinces, 30 districts and 416 sectors", () => {
    expect(ds.provinces).toHaveLength(5);
    expect(ds.provinces.flatMap((p) => p.districts)).toHaveLength(30);
    expect(ds.provinces.flatMap((p) => p.districts.flatMap((d) => d.sectors))).toHaveLength(416);
  });
  it("covers exactly the districts offered by the live form, under the same provinces", () => {
    const form: Record<string, string[]> = {
      Kigali: ["Gasabo", "Kicukiro", "Nyarugenge"],
      Northern: ["Burera", "Musanze", "Gakenke", "Gicumbi", "Rulindo"],
      Southern: ["Kamonyi", "Muhanga", "Ruhango", "Nyanza", "Huye", "Nyaruguru", "Gisagara", "Nyamagabe"],
      Eastern: ["Kayonza", "Rwamagana", "Nyagatare", "Gatsibo", "Ngoma", "Kirehe", "Bugesera"],
      Western: ["Rubavu", "Nyabihu", "Ngororero", "Rutsiro", "Karongi", "Nyamasheke", "Rusizi"],
    };
    for (const p of ds.provinces) {
      const key = Object.keys(form).find((k) => p.name.startsWith(k))!;
      expect(key, p.name).toBeDefined();
      expect(p.districts.map((d) => d.name).sort()).toEqual([...form[key]!].sort());
    }
  });
  it("has unique codes and no duplicate sector names within a district", () => {
    const codes = ds.provinces.flatMap((p) => [p.code, ...p.districts.flatMap((d) => [d.code, ...d.sectors.map((s) => s.code)])]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const d of ds.provinces.flatMap((p) => p.districts)) expect(new Set(d.sectors.map((s) => s.name.toLowerCase())).size).toBe(d.sectors.length);
  });
});

describe("LocationService", () => {
  let loc: LocationService;
  beforeAll(async () => { const db = await freshDb(); loc = new LocationService(db); await loc.load(); });

  it("resolves valid combinations, tolerating case, accents and province aliases", () => {
    for (const province of ["Kigali", "kigali city", "City of Kigali", "KIGALI"]) {
      const r = loc.resolve(province, "gasabo", "KINYINYA");
      expect(r.ok, province).toBe(true);
    }
    expect(loc.resolve("Southern", "Huye", "Ngoma").ok).toBe(true);
    expect(loc.resolve("Southern Province", "Huye", "Ngoma").ok).toBe(true);
  });
  it("rejects a district that belongs to another province", () => {
    const r = loc.resolve("Northern", "Gasabo", "Kinyinya");
    expect(r).toMatchObject({ ok: false, errors: { district: expect.stringContaining("Northern") } });
  });
  it("rejects a sector that belongs to another district", () => {
    const r = loc.resolve("Kigali", "Kicukiro", "Kinyinya");
    expect(r).toMatchObject({ ok: false, errors: { sector: expect.any(String) } });
  });
  it("rejects unknown province, district and sector without inventing any", () => {
    expect(loc.resolve("Atlantis", "x", "y")).toMatchObject({ ok: false, errors: { province: expect.any(String) } });
    expect(loc.resolve("Kigali", "Nowhere", "y")).toMatchObject({ ok: false, errors: { district: expect.any(String) } });
    expect(loc.resolve("Kigali", "Gasabo", "Nowhere")).toMatchObject({ ok: false, errors: { sector: expect.any(String) } });
    expect(loc.resolve("Kigali", "Gasabo", "")).toMatchObject({ ok: false });
  });
  it("exposes a complete tree for dropdowns", () => {
    const t = loc.tree();
    expect(t).toHaveLength(5);
    expect(t.flatMap((p) => p.districts.flatMap((d) => d.sectors))).toHaveLength(416);
  });
  it("accepts every dataset sector under its own district (round trip)", () => {
    for (const p of loc.tree()) for (const d of p.districts) for (const s of d.sectors)
      expect(loc.resolve(p.name, d.name, s.name).ok, `${p.name}/${d.name}/${s.name}`).toBe(true);
  });
});

describe("migrations", () => {
  it("apply cleanly on an empty database and are idempotent on re-run", async () => {
    const db = pgliteDb();
    const first = await runMigrations(db);
    expect(first).toEqual(["001_init.sql", "002_cells_and_school_directory.sql", "003_directory_district_level.sql"]);
    expect(await runMigrations(db)).toEqual([]);
    const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map((r) => r.tablename);
    for (const t of ["competition_editions", "provinces", "districts", "sectors", "schools", "school_registrations", "admin_users", "audit_log", "schema_migrations", "cells", "school_directory"])
      expect(tables).toContain(t);
  });

  it("detects a migration edited after it was applied", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.writeFileSync(path.join(dir, "001_a.sql"), "CREATE TABLE a (id int);");
    const db = pgliteDb();
    await runMigrations(db, dir);
    fs.writeFileSync(path.join(dir, "001_a.sql"), "CREATE TABLE a (id int, x int);");
    await expect(runMigrations(db, dir)).rejects.toThrow(/modified after being applied/);
  });

  it("rolls back a failing migration completely", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.writeFileSync(path.join(dir, "001_bad.sql"), "CREATE TABLE ok_table (id int); SELECT * FROM does_not_exist;");
    const db = pgliteDb();
    await expect(runMigrations(db, dir)).rejects.toThrow(/001_bad.sql failed/);
    const t = await db.query("SELECT 1 FROM pg_tables WHERE tablename='ok_table'");
    expect(t.rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM schema_migrations")).rowCount).toBe(0);
  });

  it("migrations directory is resolvable", () => expect(fs.existsSync(migrationsDir())).toBe(true));

  it("does not touch pre-existing unrelated tables (shared Supabase project)", async () => {
    const db = pgliteDb();
    await db.exec("CREATE TABLE problems (id int primary key, title text); INSERT INTO problems VALUES (1,'keep me');");
    await runMigrations(db);
    expect((await db.query("SELECT title FROM problems")).rows).toEqual([{ title: "keep me" }]);
  });

  it("seeding locations is idempotent", async () => {
    const db = await freshDb();
    const before = (await db.query<{ n: string }>("SELECT count(*) n FROM sectors")).rows[0]!.n;
    await seedLocations(db);
    expect((await db.query<{ n: string }>("SELECT count(*) n FROM sectors")).rows[0]!.n).toBe(before);
    expect(Number(before)).toBe(416);
  });
});

describe("schema constraints", () => {
  let db: Db; let editionId: string; let ids: { p: string; d: string; s: string; otherP: string; otherD: string };

  const insertReg = async (over: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
      registration_reference: `REF-${Math.random().toString(36).slice(2, 10)}`, competition_edition_id: editionId,
      school_id: null, school_name: "S", school_code: "1", school_code_normalized: "1", school_name_normalized: "s",
      province_id: ids.p, district_id: ids.d, sector_id: ids.s, request_fingerprint: Math.random().toString(),
      first_name: "A", last_name: "B", email_address: "a@b.co", phone_contact: "+250788000000", school_role: "Teacher", school_type: "Public",
      head_teacher_first_name: "H", head_teacher_last_name: "T", head_teacher_email: "h@b.co", head_teacher_phone: "+250788000001",
      mathematics_teacher_first_name: "M", mathematics_teacher_last_name: "T", mathematics_teacher_email: "m@b.co",
      mathematics_teacher_phone: "+250788000002", test_delivery_email: "t@b.co",
      students_p5_p6: 1, students_s1_s3: 2, students_s4_s5: 3, ...over,
    };
    if (base.school_id === null) base.school_id = (await db.query<{ id: string }>(
      "INSERT INTO schools (school_code, school_code_normalized, name) VALUES ($1,$2,'S') ON CONFLICT (school_code_normalized) DO UPDATE SET name='S' RETURNING id",
      [base.school_code, base.school_code_normalized])).rows[0]!.id;
    const cols = Object.keys(base);
    return db.query(`INSERT INTO school_registrations (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, cols.map((c) => base[c]));
  };

  beforeAll(async () => {
    db = await freshDb(); editionId = await createEdition(db);
    const q = async (sql: string, p: unknown[] = []) => (await db.query<{ id: string }>(sql, p)).rows[0]!.id;
    const p = await q("SELECT id FROM provinces WHERE name LIKE 'Kigali%'");
    const d = await q("SELECT id FROM districts WHERE name='Gasabo'");
    const s = await q("SELECT id FROM sectors WHERE name='Kinyinya' AND district_id=$1", [d]);
    const otherP = await q("SELECT id FROM provinces WHERE name LIKE 'Northern%'");
    const otherD = await q("SELECT id FROM districts WHERE name='Musanze'");
    ids = { p, d, s, otherP, otherD };
  });

  it("computes total_estimated_students in the database", async () => {
    const r = await insertReg();
    expect(r.rows[0].total_estimated_students).toBe(6);
    await expect(db.query("UPDATE school_registrations SET total_estimated_students = 99")).rejects.toThrow();
    await db.query("UPDATE school_registrations SET students_p5_p6 = 10 WHERE id=$1", [r.rows[0].id]);
    expect((await db.query("SELECT total_estimated_students t FROM school_registrations WHERE id=$1", [r.rows[0].id])).rows[0]!.t).toBe(15);
  });
  it("accepts zero students and rejects negatives", async () => {
    expect((await insertReg({ students_p5_p6: 0, students_s1_s3: 0, students_s4_s5: 0 })).rows[0].total_estimated_students).toBe(0);
    await expect(insertReg({ students_p5_p6: -1 })).rejects.toThrow();
  });
  it("rejects a district outside the province and a sector outside the district", async () => {
    await expect(insertReg({ province_id: ids.otherP })).rejects.toThrow(/foreign key/i);
    await expect(insertReg({ district_id: ids.otherD })).rejects.toThrow(/foreign key/i);
  });
  it("rejects invalid status, role, type", async () => {
    await expect(insertReg({ status: "hacked" })).rejects.toThrow();
    await expect(insertReg({ school_role: "Janitor" })).rejects.toThrow();
    await expect(insertReg({ school_type: "Charter" })).rejects.toThrow();
  });
  it("defaults status to pending and generates id and timestamps", async () => {
    const r = (await insertReg()).rows[0];
    expect(r.status).toBe("pending");
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.created_at).toBeInstanceOf(Date);
  });
  it("requires headteacher and other mandatory fields for non-legacy rows", async () => {
    for (const f of ["head_teacher_first_name", "head_teacher_last_name", "head_teacher_email", "head_teacher_phone", "test_delivery_email", "sector_id"])
      await expect(insertReg({ [f]: null }), f).rejects.toThrow(/new_registration_required_fields/);
  });
  it("allows legacy rows to lack headteacher details (no invented data)", async () => {
    const r = await insertReg({ is_legacy: true, head_teacher_first_name: null, head_teacher_last_name: null, head_teacher_phone: null, last_name: null });
    expect(r.rows[0].head_teacher_first_name).toBeNull();
  });
  it("enforces unique registration_reference", async () => {
    await insertReg({ registration_reference: "DUP-REF" });
    await expect(insertReg({ registration_reference: "DUP-REF" })).rejects.toThrow(/duplicate key/);
  });
  it("lets the same school register in several editions and twice in one edition (flag, don't block)", async () => {
    const e2 = await createEdition(db, { year: 2027, current: false });
    await insertReg({ school_code: "777", school_code_normalized: "777" });
    await insertReg({ school_code: "777", school_code_normalized: "777", competition_edition_id: e2 });
    await insertReg({ school_code: "777", school_code_normalized: "777" });
    const n = await db.query("SELECT count(DISTINCT school_id) c, count(*) n FROM school_registrations WHERE school_code='777'");
    expect(n.rows[0]).toMatchObject({ c: 1, n: 3 });
  });
  it("allows only one current edition", async () => {
    await expect(createEdition(db, { year: 2030, current: true })).rejects.toThrow(/duplicate key/);
  });
  it("stores leading zeros and long digit strings as text", async () => {
    const r = (await insertReg({ school_code: "000123", school_code_normalized: "000123", school_bank_account: "000000012345678901234" })).rows[0];
    expect(r.school_code).toBe("000123");
    expect(r.school_bank_account).toBe("000000012345678901234");
  });
  it("keeps test_delivery_email, teacher and school bank details in separate columns", async () => {
    const r = (await insertReg({ school_bank_name: "SB", school_bank_account: "11111", teacher_bank_name: "TB", mathematics_teacher_account_number: "22222",
      mathematics_teacher_email: "m@x.co", test_delivery_email: "other@x.co" })).rows[0];
    expect([r.school_bank_account, r.mathematics_teacher_account_number, r.mathematics_teacher_email, r.test_delivery_email]).toEqual(["11111", "22222", "m@x.co", "other@x.co"]);
  });
  it("makes the audit log append-only", async () => {
    await db.query("INSERT INTO audit_log (actor_label, action, entity_type) VALUES ('t','a','e')");
    await expect(db.query("UPDATE audit_log SET action='x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
  });
  it("enables row-level security (no policies) on every table", async () => {
    const rows = (await db.query<{ tablename: string; rowsecurity: boolean }>(
      "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'")).rows;
    for (const r of rows) expect(r.rowsecurity, r.tablename).toBe(true);
    expect((await db.query("SELECT 1 FROM pg_policies WHERE schemaname='public'")).rowCount).toBe(0);
  });
  it("rolls back a transaction atomically", async () => {
    const before = (await db.query<{ n: string }>("SELECT count(*) n FROM schools")).rows[0]!.n;
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO schools (school_code, school_code_normalized, name) VALUES ('rb','rb','x')");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await db.query<{ n: string }>("SELECT count(*) n FROM schools")).rows[0]!.n).toBe(before);
  });
});
