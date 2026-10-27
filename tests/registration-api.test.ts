/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createEdition, makeApp, validPayload } from "./helpers.js";
import type { Db } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

let app: FastifyInstance; let db: Db; let editionId: string;
beforeEach(async () => { ({ app, db, editionId } = await makeApp()); });

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/school-registrations", payload: payload as any, headers });

describe("POST /api/school-registrations", () => {
  it("stores every field correctly, keeping headteacher, teacher and bank data separate", async () => {
    const res = await post(validPayload());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.registration.registration_reference).toMatch(/^ROF-2026-[2-9A-HJ-NP-Z]{8}$/);
    expect(body.registration.status).toBe("pending");
    expect(body.registration.total_estimated_students).toBe(30);
    expect(body.registration.competition_edition).toBe("Test Olympiad 2026");

    const row = (await db.query("SELECT r.*, p.name province, d.name district, s.name sector FROM school_registrations r JOIN provinces p ON p.id=r.province_id JOIN districts d ON d.id=r.district_id JOIN sectors s ON s.id=r.sector_id")).rows[0]!;
    expect(row).toMatchObject({
      first_name: "Aline", last_name: "Uwase", email_address: "aline.uwase@example.org", phone_contact: "+250788123456", school_role: "Teacher",
      school_name: "Groupe Scolaire Test", school_code: "012345", school_type: "Public",
      province: "Kigali City", district: "Gasabo", sector: "Kinyinya",
      school_bank_name: "Test Bank", school_bank_account: "0001234567890",
      head_teacher_first_name: "Jean", head_teacher_last_name: "Mugabo", head_teacher_email: "head@example.org", head_teacher_phone: "+250722000111",
      mathematics_teacher_first_name: "Claire", mathematics_teacher_last_name: "Ingabire", mathematics_teacher_email: "claire@example.org",
      mathematics_teacher_phone: "+250733000222", test_delivery_email: "tests@example.org",
      teacher_bank_name: "Other Bank", mathematics_teacher_account_number: "00098765432",
      students_p5_p6: 10, students_s1_s3: 20, students_s4_s5: 0, total_estimated_students: 30,
      questions_comments_concerns_feedback: "Is there a fee?", additional_information: "We have a computer lab.",
      status: "pending", is_legacy: false, competition_edition_id: editionId,
    });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    // public response must not leak submitted private data
    expect(JSON.stringify(body)).not.toContain("0001234567890");
    expect(JSON.stringify(body)).not.toContain("head@example.org");
  });

  it("ignores client-supplied status, id, reference, edition and totals", async () => {
    const res = await post(validPayload({
      status: "approved", id: "00000000-0000-0000-0000-000000000000", registration_reference: "HACKED",
      competition_edition_id: "00000000-0000-0000-0000-000000000000", total_estimated_students: 99999, created_at: "1999-01-01", is_legacy: true,
    }));
    expect(res.statusCode).toBe(201);
    const row = (await db.query("SELECT * FROM school_registrations")).rows[0]!;
    expect(row.status).toBe("pending");
    expect(row.id).not.toBe("00000000-0000-0000-0000-000000000000");
    expect(row.registration_reference).not.toBe("HACKED");
    expect(row.total_estimated_students).toBe(30);
    expect(row.is_legacy).toBe(false);
    expect(row.competition_edition_id).toBe(editionId);
    expect(row.created_at.getFullYear()).toBeGreaterThan(2000);
  });

  it("accepts zero students everywhere", async () => {
    const res = await post(validPayload({ students_p5_p6: 0, students_s1_s3: 0, students_s4_s5: 0 }));
    expect(res.statusCode).toBe(201);
    expect(res.json().registration.total_estimated_students).toBe(0);
  });

  it("works with all optional fields omitted", async () => {
    const p = validPayload();
    for (const k of ["school_bank_name", "school_bank_account", "teacher_bank_name", "mathematics_teacher_account_number", "questions_comments_concerns_feedback", "additional_information"]) delete p[k];
    expect((await post(p)).statusCode).toBe(201);
  });

  it("returns field-specific validation errors and stores nothing", async () => {
    const res = await post(validPayload({ email_address: "bad", phone_contact: "123", students_p5_p6: -2, school_role: "Janitor", head_teacher_first_name: "" }));
    expect(res.statusCode).toBe(422);
    const { error } = res.json();
    expect(error.code).toBe("validation_failed");
    expect(Object.keys(error.fields).sort()).toEqual(["email_address", "head_teacher_first_name", "phone_contact", "school_role", "students_p5_p6"]);
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM schools")).rowCount).toBe(0);
  });

  it("requires every headteacher field", async () => {
    for (const f of ["head_teacher_first_name", "head_teacher_last_name", "head_teacher_email", "head_teacher_phone"]) {
      const p = validPayload(); delete p[f];
      const res = await post(p);
      expect(res.statusCode, f).toBe(422);
      expect(res.json().error.fields[f]).toBeDefined();
    }
  });

  it("rejects invalid province/district/sector combinations with field errors", async () => {
    let res = await post(validPayload({ province: "Northern", district: "Gasabo" }));
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.district).toBeDefined();
    res = await post(validPayload({ sector: "Atlantis" }));
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.sector).toBeDefined();
    res = await post(validPayload({ province: "Mars" }));
    expect(res.statusCode).toBe(422); expect(res.json().error.fields.province).toBeDefined();
  });

  it("accepts the live form's province labels (Kigali, Northern, ...)", async () => {
    const r = await post(validPayload({ school_code: "9001", province: "Southern", district: "Huye", sector: "Ngoma" }));
    expect(r.statusCode).toBe(201);
  });

  it("does not reject teachers sharing an email or similar school names", async () => {
    expect((await post(validPayload({ school_code: "1", mathematics_teacher_email: "same@example.org", head_teacher_email: "same@example.org", email_address: "same@example.org" }))).statusCode).toBe(201);
    expect((await post(validPayload({ school_code: "2", mathematics_teacher_email: "same@example.org", school_name: "Groupe Scolaire Test II" }))).statusCode).toBe(201);
  });

  it("returns 409 when no edition is open or current", async () => {
    await db.query("UPDATE competition_editions SET registration_open = false");
    const res = await post(validPayload());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("registration_closed");
    await db.query("UPDATE competition_editions SET registration_open = true, is_current = false");
    expect((await post(validPayload())).statusCode).toBe(409);
  });

  it("rejects malformed JSON, non-JSON content and oversized bodies without a 500", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/school-registrations", payload: "{not json", headers: { "content-type": "application/json" } });
    expect(bad.statusCode).toBe(400);
    const text = await app.inject({ method: "POST", url: "/api/school-registrations", payload: "hello", headers: { "content-type": "text/plain" } });
    expect(text.statusCode).toBe(415);
    const big = await post(validPayload({ additional_information: "x".repeat(70_000) }));
    expect(big.statusCode).toBe(413);
    for (const body of ["[]", "null", "42"]) {
      const r = await app.inject({ method: "POST", url: "/api/school-registrations", payload: body, headers: { "content-type": "application/json" } });
      expect(r.statusCode).toBe(422);
    }
  });

  it("is safe against SQL injection payloads (stored literally, tables intact)", async () => {
    const evil = "Robert'); DROP TABLE school_registrations;--";
    const res = await post(validPayload({ school_name: evil, additional_information: evil }));
    expect(res.statusCode).toBe(201);
    expect((await db.query("SELECT school_name FROM school_registrations")).rows[0]!.school_name).toBe(evil);
  });

  it("stores markup literally (output is JSON/CSV only; no HTML rendering here)", async () => {
    const res = await post(validPayload({ additional_information: "<img src=x onerror=alert(1)>" }));
    expect(res.statusCode).toBe(201);
  });

  it("silently drops honeypot submissions without saving", async () => {
    const res = await post(validPayload({ website: "http://spam.example" }));
    expect(res.statusCode).toBe(202);
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(0);
  });

  it("sets security headers and does not cache responses", async () => {
    const res = await post(validPayload());
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows CORS only for configured origins", async () => {
    const ok = await app.inject({ method: "OPTIONS", url: "/api/school-registrations", headers: { origin: "https://rwandamathcompetition.netlify.app", "access-control-request-method": "POST", "access-control-request-headers": "content-type,idempotency-key" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://rwandamathcompetition.netlify.app");
    expect(String(ok.headers["access-control-allow-headers"]).toLowerCase()).toContain("idempotency-key");
    const bad = await app.inject({ method: "OPTIONS", url: "/api/school-registrations", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("retry handling and idempotency", () => {
  it("replays the same Idempotency-Key without creating a second registration", async () => {
    const a = await post(validPayload(), { "idempotency-key": "key-12345678" });
    const b = await post(validPayload(), { "idempotency-key": "key-12345678" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().registration.registration_reference).toBe(a.json().registration.registration_reference);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(1);
  });
  it("rejects reuse of a key with a different payload", async () => {
    await post(validPayload(), { "idempotency-key": "key-12345678" });
    const b = await post(validPayload({ school_code: "999" }), { "idempotency-key": "key-12345678" });
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe("idempotency_key_reused");
  });
  it("rejects malformed keys", async () => {
    for (const k of ["short", "has space in it!", "x".repeat(200)])
      expect((await post(validPayload(), { "idempotency-key": k })).statusCode).toBe(400);
  });
  it("treats a byte-identical retry without a key as a repeated delivery", async () => {
    const a = await post(validPayload());
    const b = await post(validPayload({ email_address: "ALINE.UWASE@example.org  " })); // same after normalization
    expect(b.statusCode).toBe(200);
    expect(b.json().registration.id).toBe(a.json().registration.id);
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(1);
  });
  it("collapses simultaneous identical requests into one registration", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => post(validPayload())));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(1);
  });
  it("collapses simultaneous requests sharing an Idempotency-Key", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post(validPayload(), { "idempotency-key": "race-key-123" })));
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(1);
  });
  it("treats a genuinely different submission (different payload) as new, even for the same school", async () => {
    const a = await post(validPayload());
    const b = await post(validPayload({ students_p5_p6: 11 }));
    expect(b.statusCode).toBe(201);
    expect(b.json().registration.id).not.toBe(a.json().registration.id);
    expect(b.json().registration.registration_reference).not.toBe(a.json().registration.registration_reference);
    expect((await db.query("SELECT count(DISTINCT school_id)::int c FROM school_registrations")).rows[0]!.c).toBe(1);
  });
  it("lets the same school register again in a later edition without touching history", async () => {
    const first = await post(validPayload());
    await db.query("UPDATE competition_editions SET is_current = false, registration_open = false");
    const e2 = await createEdition(db, { year: 2027 });
    const second = await post(validPayload());
    expect(second.statusCode).toBe(201);
    expect(second.json().registration.id).not.toBe(first.json().registration.id);
    const rows = (await db.query("SELECT competition_edition_id e, school_id s FROM school_registrations ORDER BY created_at")).rows;
    expect(rows[0]!.e).toBe(editionId);
    expect(rows[1]!.e).toBe(e2);
    expect(rows[0]!.s).toBe(rows[1]!.s);
  });
});

describe("failure handling", () => {
  it("rolls back every related record when saving fails part-way", async () => {
    const failing: Db = {
      ...db,
      transaction: (fn) => db.transaction((tx) => fn({
        ...tx,
        query: (text: string, params?: unknown[]) => {
          if (text.includes("INSERT INTO audit_log")) return Promise.reject(new Error("simulated failure"));
          return tx.query(text, params);
        },
      })),
    };
    const badApp = await buildApp({ db: failing, config: testConfig() });
    const res = await badApp.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload() as any });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
    expect(res.body).not.toContain("simulated failure");
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM schools")).rowCount).toBe(0);
    // and the same request succeeds once the fault is gone (safe to retry)
    expect((await post(validPayload())).statusCode).toBe(201);
  });
  it("returns a generic 500 (no SQL/stack details) on database errors", async () => {
    const broken: Db = { ...db, query: () => Promise.reject(new Error("connection refused 10.0.0.5")), transaction: () => Promise.reject(new Error("connection refused 10.0.0.5")) };
    const badApp = await buildApp({ db: { ...broken, query: db.query }, config: testConfig() });
    // lookups work (needed at boot) but writes fail
    const brokenWrites = await buildApp({ db: { ...db, transaction: broken.transaction }, config: testConfig() });
    const res = await brokenWrites.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload() as any });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("10.0.0.5");
    void badApp;
  });
  it("health reports unavailable when the database is down", async () => {
    const down = await buildApp({ db: { ...db, query: async (t: string, p?: unknown[]) => { if (t === "SELECT 1") throw new Error("down"); return db.query(t, p); } } as Db, config: testConfig() });
    expect((await down.inject({ url: "/health" })).statusCode).toBe(503);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});

describe("rate limiting", () => {
  it("throttles public submissions per client", async () => {
    const limited = await makeApp({ publicRateLimitMax: 3, publicRateLimitWindowMs: 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload({ school_code: String(100 + i) }) as any })).statusCode);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
  });
});

describe("public reference endpoints", () => {
  it("serves the location tree and the current edition, and nothing private", async () => {
    const loc = await app.inject({ url: "/api/locations" });
    expect(loc.statusCode).toBe(200);
    expect(loc.json().provinces).toHaveLength(5);
    const ed = await app.inject({ url: "/api/competition-editions/current" });
    expect(ed.json()).toMatchObject({ year: 2026, registration_open: true });
  });
  it("gives public users no way to list or read registrations", async () => {
    await post(validPayload());
    for (const [method, url] of [["GET", "/api/school-registrations"], ["GET", "/api/school-registrations/export"], ["GET", "/api/school-registrations/statistics"]] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
    }
  });
});
