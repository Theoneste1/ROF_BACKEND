import { beforeAll, describe, expect, it } from "vitest";
import { createEdition, freshDb, validPayload } from "./helpers.js";
import { importLegacyCsv, parseCsv } from "../src/legacyImport.js";
import { LocationService } from "../src/locations.js";
import { createRegistration } from "../src/registrations.js";
import { validateRegistration } from "../src/validation.js";
import type { Db } from "../src/db.js";

const HEADER = ["Timestamp", "Your full Name", "Email Address", "Phone contact", "School Name", "School Code", "School Type", "Choose school Province", "Choose School District", "School Sector",
  "School Bank Name", "School Bank Account", "Mathematics Teachers's full Name", "Mathematics teachers Email address", "Mathematics teachers Phone contact", "Teacher's Bank Name",
  "Mathematics Teacher's Account Number", "Head teacher's email address", "What is your role at school?",
  "How many students from P5 to P6 from your school who will attend the competition?", "How many student from S1 to S3  from your school who will attend the competition?",
  "How many number of students from S4 to S5 from your school who will attend the competition?", "Could you confirm which email address on which we should send the test",
  "Any question/comment/concern/feedbacks", "Anything you want us to know"];
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const row = (o: Record<string, string>) => HEADER.map((h) => q(o[h] ?? "")).join(",");
const CSV = [HEADER.map(q).join(","),
  row({ Timestamp: "2025-05-01 10:00:00", "Your full Name": "Jean Claude Habimana", "Email Address": "JC@Example.org", "Phone contact": "0788000111", "School Name": "Old School, \"Quoted\"", "School Code": "000777",
    "School Type": "Public", "Choose school Province": "Kigali", "Choose School District": "Gasabo", "School Sector": "Kinyinya", "School Bank Account": "000123456", "Mathematics Teachers's full Name": "Marie Teacher",
    "What is your role at school?": "Teacher", "How many students from P5 to P6 from your school who will attend the competition?": "12",
    "How many student from S1 to S3  from your school who will attend the competition?": "abc", "Anything you want us to know": "line1\nline2" }),
  row({ "Your full Name": "No Code", "School Name": "Missing Code School", "Choose school Province": "Kigali", "Choose School District": "Gasabo" }),
  row({ "Your full Name": "Bad Place", "School Name": "Nowhere School", "School Code": "1", "Choose school Province": "Atlantis", "Choose School District": "x" }),
  row({ "Your full Name": "Typo Sector", "School Name": "Typo School", "School Code": "0042", "School Type": "Weird", "Choose school Province": "Northern", "Choose School District": "Musanze", "School Sector": "Muhozaa" }),
].join("\r\n");

let db: Db; let loc: LocationService; let editionId: string;
beforeAll(async () => { db = await freshDb(); editionId = await createEdition(db, { year: 2025, slug: "2025", current: false, open: false }); loc = new LocationService(db); await loc.load(); });

describe("CSV parser", () => {
  it("handles quotes, embedded commas/newlines, CRLF and BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi""\nthere"\r\n')).toEqual([["a", "b"], ["x,1", 'he said "hi"\nthere']]);
  });
});

describe("legacy Google Sheet import", () => {
  it("dry run writes nothing but reports what would happen", async () => {
    const rep = await importLegacyCsv(db, loc, CSV, "2025", false);
    expect(rep).toMatchObject({ total: 4, imported: 2, alreadyImported: 0 });
    expect(rep.skipped.map((s) => s.reason)).toEqual(["missing school name or school code", "province/district not recognised"]);
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(0);
  });
  it("imports historical rows without inventing or altering data", async () => {
    await importLegacyCsv(db, loc, CSV, "2025", true);
    const r = (await db.query("SELECT * FROM school_registrations WHERE school_code='000777'")).rows[0]!;
    expect(r).toMatchObject({
      is_legacy: true, status: "pending", first_name: "Jean Claude Habimana", last_name: null, email_address: "jc@example.org",
      phone_contact: "+250788000111", school_code: "000777", school_name: 'Old School, "Quoted"', school_type: "Public",
      mathematics_teacher_first_name: "Marie Teacher", mathematics_teacher_last_name: null,
      head_teacher_first_name: null, head_teacher_last_name: null, head_teacher_phone: null,
      school_bank_account: "000123456", students_p5_p6: 12, students_s1_s3: null, students_s4_s5: null, additional_information: "line1\nline2",
    });
    expect(r.legacy_raw["School Code"]).toBe("000777");
    expect(r.total_estimated_students).toBe(12);
    expect(r.created_at.toISOString()).toContain("2025-05-01");
  });
  it("keeps unmatched sector text and leaves invalid enum values empty", async () => {
    const r = (await db.query("SELECT sector_id, sector_name_raw, school_type FROM school_registrations WHERE school_code='0042'")).rows[0]!;
    expect(r).toEqual({ sector_id: null, sector_name_raw: "Muhozaa", school_type: null });
  });
  it("is idempotent: running again adds nothing", async () => {
    const rep = await importLegacyCsv(db, loc, CSV, "2025", true);
    expect(rep).toMatchObject({ imported: 0, alreadyImported: 2 });
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(2);
  });
  it("refuses an unknown edition", async () => {
    await expect(importLegacyCsv(db, loc, CSV, "nope", true)).rejects.toThrow(/does not exist/);
  });
  it("legacy rows are reported as incomplete and survive new registrations untouched", async () => {
    const before = (await db.query("SELECT * FROM school_registrations WHERE is_legacy ORDER BY school_code")).rows;
    const cur = await createEdition(db, { year: 2026, slug: "2026" });
    void cur;
    const parsed = validateRegistration(validPayload({ school_code: "000777", school_name: "Old School, \"Quoted\"" }));
    if (!parsed.ok) throw new Error("fixture invalid");
    await createRegistration(db, loc, parsed.data, {});
    const after = (await db.query("SELECT * FROM school_registrations WHERE is_legacy ORDER BY school_code")).rows;
    expect(after).toEqual(before);
    // same school code in a later edition links to the same school identity (history preserved)
    const schools = (await db.query("SELECT count(DISTINCT school_id)::int c FROM school_registrations WHERE school_code='000777'")).rows[0]!.c;
    expect(schools).toBe(1);
    expect(editionId).toBeTruthy();
  });
});
