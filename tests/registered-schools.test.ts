/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAdmin, createEdition, loginAs, makeApp, validPayload } from "./helpers.js";
import type { Db } from "../src/db.js";

let app: FastifyInstance; let db: Db; let editionId: string; let token: string;
const get = (url: string) => app.inject({ method: "GET", url });
const submit = (over: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload(over) as any });
const setStatus = (id: string, status: string, note?: string) =>
  app.inject({ method: "PATCH", url: `/api/school-registrations/${id}/status`, payload: { status, note } as any, headers: { authorization: `Bearer ${token}` } });
const ids: Record<string, string> = {};

beforeAll(async () => {
  ({ app, db, editionId } = await makeApp());
  await createAdmin(db, "super_admin"); token = await loginAs(app, "super_admin@test.example");
  // three schools in two districts
  ids.a = (await submit({ school_name: "Zeta School", school_code: "100", province: "Kigali", district: "Gasabo", sector: "Kinyinya", students_p5_p6: 1, students_s1_s3: 2, students_s4_s5: 3, email_address: "private.a@example.org" })).json().registration.id;
  ids.b = (await submit({ school_name: "Alpha School", school_code: "200", province: "Southern", district: "Huye", sector: "Ngoma", students_p5_p6: 10, students_s1_s3: 0, students_s4_s5: 0, school_bank_account: "7777777777" })).json().registration.id;
  ids.c = (await submit({ school_name: "Beta School", school_code: "300", province: "Kigali", district: "Gasabo", sector: "Kinyinya", students_p5_p6: 4, students_s1_s3: 4, students_s4_s5: 4 })).json().registration.id;
});

describe("GET /api/registered-schools (public)", () => {
  it("needs no authentication and returns only school code, name, district and student count", async () => {
    const res = await get("/api/registered-schools");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.edition).toEqual({ name: "Test Olympiad 2026", year: 2026 });
    expect(body.schools.map((s: any) => s.school_name)).toEqual(["Alpha School", "Beta School", "Zeta School"]); // sorted by name
    for (const s of body.schools) expect(Object.keys(s).sort()).toEqual(["district", "school_code", "school_name", "student_count"]);
    expect(body.schools.find((s: any) => s.school_code === "100")).toEqual({ school_code: "100", school_name: "Zeta School", district: "Gasabo", student_count: 6 });
    expect(body).toMatchObject({ total_schools: 3, total_students: 6 + 10 + 12 });
  });
  it("never leaks contact details, bank details, status or ids", async () => {
    const text = (await get("/api/registered-schools")).body;
    for (const secret of ["private.a@example.org", "head@example.org", "claire@example.org", "7777777777", "0788123456", "+250788", "pending", ids.a, ids.b, "Mugabo", "Uwase"])
      expect(text, secret).not.toContain(secret);
  });
  it("lists a school once, using its most recent registration, even if it registered twice", async () => {
    await submit({ school_name: "Zeta School", school_code: "100", province: "Kigali", district: "Gasabo", sector: "Kinyinya", students_p5_p6: 50, students_s1_s3: 0, students_s4_s5: 0, first_name: "Second" });
    const body = (await get("/api/registered-schools")).json();
    expect(body.schools.filter((s: any) => s.school_code === "100")).toHaveLength(1);
    expect(body.schools.find((s: any) => s.school_code === "100").student_count).toBe(50);
    expect(body.total_schools).toBe(3);
    expect(body.total_students).toBe(50 + 10 + 12);
  });
  it("excludes rejected and withdrawn registrations, and includes pending and approved ones", async () => {
    expect((await setStatus(ids.b!, "rejected", "spam")).statusCode).toBe(200);
    expect((await get("/api/registered-schools")).json().schools.map((s: any) => s.school_code)).not.toContain("200");
    expect((await setStatus(ids.b!, "withdrawn", "withdrawn")).statusCode).toBe(200);
    expect((await get("/api/registered-schools")).json().schools.map((s: any) => s.school_code)).not.toContain("200");
    expect((await setStatus(ids.b!, "approved")).statusCode).toBe(200);
    expect((await get("/api/registered-schools")).json().schools.map((s: any) => s.school_code)).toContain("200");
  });
  it("defaults to the current edition and supports edition_id", async () => {
    const other = await createEdition(db, { year: 2095, slug: "2095", current: false, open: false });
    const empty = (await get(`/api/registered-schools?edition_id=${other}`)).json();
    expect(empty).toMatchObject({ edition: { year: 2095 }, total_schools: 0, total_students: 0, schools: [] });
    expect((await get(`/api/registered-schools?edition_id=${editionId}`)).json().total_schools).toBe(3);
    expect((await get("/api/registered-schools?edition_id=nope")).statusCode).toBe(422);
  });
  it("returns an empty list (not an error) when no edition is current", async () => {
    await db.query("UPDATE competition_editions SET is_current = false");
    const res = await get("/api/registered-schools");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ edition: null, total_schools: 0, total_students: 0, schools: [] });
    await db.query("UPDATE competition_editions SET is_current = true WHERE id = $1", [editionId]);
  });
  it("counts legacy rows with missing student numbers as zero", async () => {
    const dist = (await db.query<{ id: string; province_id: string }>("SELECT id, province_id FROM districts WHERE name='Kicukiro'")).rows[0]!;
    await db.query(
      `INSERT INTO schools (school_code, school_code_normalized, name) VALUES ('555','555','Legacy School')`);
    const school = (await db.query<{ id: string }>("SELECT id FROM schools WHERE school_code='555'")).rows[0]!.id;
    await db.query(
      `INSERT INTO school_registrations (registration_reference, competition_edition_id, school_id, school_name, school_code, school_code_normalized, school_name_normalized,
         province_id, district_id, request_fingerprint, is_legacy) VALUES ('ROF-LEG-TEST1', $1, $2, 'Legacy School', '555', '555', 'legacyschool', $3, $4, 'fp-legacy', true)`,
      [editionId, school, dist.province_id, dist.id]);
    const row = (await get("/api/registered-schools")).json().schools.find((s: any) => s.school_code === "555");
    expect(row).toEqual({ school_code: "555", school_name: "Legacy School", district: "Kicukiro", student_count: 0 });
  });
  it("is cacheable by browsers and CDNs for a minute, unlike admin responses", async () => {
    expect((await get("/api/registered-schools")).headers["cache-control"]).toBe("public, max-age=60");
    expect((await app.inject({ method: "GET", url: "/api/school-registrations" })).headers["cache-control"]).toBe("no-store");
  });
  it("allows the website origin via CORS", async () => {
    const res = await app.inject({ method: "GET", url: "/api/registered-schools", headers: { origin: "https://rwandamathcompetition.netlify.app" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://rwandamathcompetition.netlify.app");
  });
  it("is rate limited per client", async () => {
    const limited = await makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await limited.app.inject({ method: "GET", url: "/api/registered-schools" })).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
  });
});
