/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAdmin, makeApp, PASSWORD } from "./helpers.js";
import type { Db } from "../src/db.js";
import { loadConfig } from "../src/config.js";

/**
 * Contract mapping from the live form's state (src/pages/CompetitionRegistration.tsx, FormState)
 * to this API. The form gains three headteacher inputs; everything else maps 1:1.
 */
const formToApiPayload = (f: Record<string, string>) => ({
  first_name: f.firstName, last_name: f.lastName, email_address: f.email, phone_contact: f.phone, school_role: f.role,
  school_name: f.schoolName, school_code: f.schoolCode, school_type: f.schoolType,
  province: f.province, district: f.district, sector: f.sector,
  school_bank_name: f.schoolBankName, school_bank_account: f.schoolBankAccount,
  head_teacher_first_name: f.headTeacherFirstName, head_teacher_last_name: f.headTeacherLastName,
  head_teacher_email: f.headTeacherEmail, head_teacher_phone: f.headTeacherPhone,
  mathematics_teacher_first_name: f.teacherFirstName, mathematics_teacher_last_name: f.teacherLastName,
  mathematics_teacher_email: f.teacherEmail, mathematics_teacher_phone: f.teacherPhone,
  test_delivery_email: f.testEmail, teacher_bank_name: f.teacherBankName, mathematics_teacher_account_number: f.teacherBankAccount,
  students_p5_p6: f.primaryStudentCount, students_s1_s3: f.juniorStudentCount, students_s4_s5: f.seniorStudentCount,
  questions_comments_concerns_feedback: f.comments, additional_information: f.additionalInfo,
});

// All values synthetic. Strings exactly as an <input> would produce them.
const FORM_STATE = {
  firstName: "Esther", lastName: "Mukamana", email: "esther.test@example.org", phone: "0788123456", role: "Head Teacher",
  schoolName: "Synthetic Secondary School", schoolCode: "004321", schoolType: "Government Aided",
  province: "Eastern", district: "Rwamagana", sector: "Kigabiro",
  schoolBankName: "Synthetic Bank", schoolBankAccount: "000555000111",
  headTeacherFirstName: "Pierre", headTeacherLastName: "Nsengimana", headTeacherEmail: "pierre.head@example.org", headTeacherPhone: "0722111222",
  teacherFirstName: "Grace", teacherLastName: "Uwimana", teacherEmail: "grace.math@example.org", teacherPhone: "0733222333",
  testEmail: "exams.synthetic@example.org", teacherBankName: "Teacher Test Bank", teacherBankAccount: "000999888777",
  primaryStudentCount: "12", juniorStudentCount: "0", seniorStudentCount: "8",
  comments: "Synthetic comment", additionalInfo: "Synthetic extra info",
};

let app: FastifyInstance; let db: Db; let base: string;
beforeAll(async () => {
  ({ app, db } = await makeApp());
  await createAdmin(db, "super_admin");
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
});
afterAll(async () => { await app.close(); });

const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });

describe("end-to-end over real HTTP", () => {
  it("full workflow: preflight → submit → retry → admin login → retrieve → update → status → search → export → statistics", async () => {
    // 1. browser preflight from the production site origin
    const pre = await fetch(`${base}/api/school-registrations`, { method: "OPTIONS", headers: { origin: "https://rwandamathcompetition.netlify.app", "access-control-request-method": "POST", "access-control-request-headers": "content-type,idempotency-key" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://rwandamathcompetition.netlify.app");

    // 2. public submit, using the form's own value formats
    const key = "e2e-key-0001-abcdef";
    const submit = () => fetch(`${base}/api/school-registrations`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://rwandamathcompetition.netlify.app", "idempotency-key": key },
      body: JSON.stringify(formToApiPayload(FORM_STATE)),
    }).then(json);
    const created = await submit();
    expect(created.status).toBe(201);
    expect(created.headers.get("access-control-allow-origin")).toBe("https://rwandamathcompetition.netlify.app");
    const { id, registration_reference, total_estimated_students } = created.body.registration;
    expect(registration_reference).toMatch(/^ROF-2026-/);
    expect(total_estimated_students).toBe(20);

    // 3. network retry with the same key returns the same registration
    const retry = await submit();
    expect(retry.status).toBe(200);
    expect(retry.body.registration.id).toBe(id);

    // 4. public cannot read anything
    expect((await fetch(`${base}/api/school-registrations/${id}`)).status).toBe(401);
    expect((await fetch(`${base}/api/school-registrations`)).status).toBe(401);

    // 5. admin
    const login = await json(await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "super_admin@test.example", password: PASSWORD }) }));
    expect(login.status).toBe(200);
    const h = { authorization: `Bearer ${login.body.token}`, "content-type": "application/json" };

    const detail = await json(await fetch(`${base}/api/school-registrations/${id}?reveal_bank=true`, { headers: h }));
    expect(detail.body).toMatchObject({
      registration_reference, first_name: "Esther", last_name: "Mukamana", school_role: "Head Teacher", school_type: "Government Aided",
      school_code: "004321", province: "Eastern Province", district: "Rwamagana", sector: "Kigabiro",
      head_teacher_first_name: "Pierre", head_teacher_last_name: "Nsengimana", head_teacher_email: "pierre.head@example.org", head_teacher_phone: "+250722111222",
      mathematics_teacher_first_name: "Grace", mathematics_teacher_email: "grace.math@example.org", test_delivery_email: "exams.synthetic@example.org",
      school_bank_account: "000555000111", mathematics_teacher_account_number: "000999888777", school_bank_name: "Synthetic Bank", teacher_bank_name: "Teacher Test Bank",
      students_p5_p6: 12, students_s1_s3: 0, students_s4_s5: 8, total_estimated_students: 20, status: "pending",
      questions_comments_concerns_feedback: "Synthetic comment", additional_information: "Synthetic extra info",
    });

    // 6. update + status persist
    const upd = await json(await fetch(`${base}/api/school-registrations/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ students_s1_s3: 5 }) }));
    expect(upd.body.total_estimated_students).toBe(25);
    const st = await json(await fetch(`${base}/api/school-registrations/${id}/status`, { method: "PATCH", headers: h, body: JSON.stringify({ status: "approved", note: "ok" }) }));
    expect(st.body.status).toBe("approved");

    // 7. search / filter / stats / export
    const found = await json(await fetch(`${base}/api/school-registrations?q=Synthetic&province=Eastern&status=approved`, { headers: h }));
    expect(found.body.pagination.total).toBe(1);
    expect(found.body.data[0].school_bank_account).toBe("*********111");
    const stats = await json(await fetch(`${base}/api/school-registrations/statistics`, { headers: h }));
    expect(stats.body.totals).toMatchObject({ registrations: 1, total_estimated_students: 25, students_s1_s3: 5 });
    const csv = await (await fetch(`${base}/api/school-registrations/export?include_bank=true`, { headers: h })).text();
    expect(csv).toContain(registration_reference);
    expect(csv).toContain('"=""004321"""');
    expect(csv).toContain('"=""000555000111"""');

    // 8. exactly one row exists despite the retry
    expect((await db.query("SELECT 1 FROM school_registrations")).rowCount).toBe(1);
  });

  it("returns clear field errors for an incomplete form submission (old form without headteacher fields)", async () => {
    const old = formToApiPayload({ ...FORM_STATE, schoolCode: "555" }) as any;
    delete old.head_teacher_first_name; delete old.head_teacher_last_name; delete old.head_teacher_phone;
    const res = await json(await fetch(`${base}/api/school-registrations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(old) }));
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(["head_teacher_first_name", "head_teacher_last_name", "head_teacher_phone"]);
  });
});

describe("configuration", () => {
  const ok = { DATABASE_URL: "postgres://x", JWT_SECRET: "x".repeat(32) };
  it("loads valid config with safe defaults", () => {
    const c = loadConfig({ ...ok } as any);
    expect(c).toMatchObject({ port: 8787, corsOrigins: ["https://rwandamathcompetition.netlify.app", "https://math.rwandaolympiadfoundation.org"], trustProxy: false, databaseSsl: false });
  });
  it("requires DATABASE_URL and a strong JWT_SECRET", () => {
    expect(() => loadConfig({} as any)).toThrow(/DATABASE_URL, JWT_SECRET/);
    expect(() => loadConfig({ ...ok, JWT_SECRET: "short" } as any)).toThrow(/at least 32/);
  });
  it("turns TLS on and forbids wildcard CORS in production", () => {
    expect(loadConfig({ ...ok, NODE_ENV: "production" } as any).databaseSsl).toBe(true);
    expect(() => loadConfig({ ...ok, NODE_ENV: "production", CORS_ORIGINS: "*" } as any)).toThrow(/explicit origins/);
  });
});

describe("database TLS configuration", () => {
  const ok = { DATABASE_URL: "postgres://x", JWT_SECRET: "x".repeat(32) };
  it("reads a CA certificate with escaped newlines and verifies by default", () => {
    const c = loadConfig({ ...ok, DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----" } as any);
    expect(c.databaseSslCa).toBe("-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----");
    expect(c.databaseSslRejectUnauthorized).toBe(true);
  });
  it("only skips verification when explicitly told to", () => {
    expect(loadConfig({ ...ok, DATABASE_SSL_REJECT_UNAUTHORIZED: "false" } as any).databaseSslRejectUnauthorized).toBe(false);
    expect(loadConfig({ ...ok } as any).databaseSslCa).toBeUndefined();
  });
});
