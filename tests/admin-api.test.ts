/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PASSWORD, createAdmin, createEdition, loginAs, makeApp, validPayload } from "./helpers.js";
import type { Db } from "../src/db.js";
import { signToken } from "../src/auth.js";

let app: FastifyInstance; let db: Db; let editionId: string;
let tok: Record<"viewer" | "admin" | "finance" | "super_admin", string>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const get = (url: string, t = tok.super_admin) => app.inject({ method: "GET", url, headers: auth(t) });
const send = (method: "PATCH" | "POST", url: string, payload: unknown, t = tok.super_admin) =>
  app.inject({ method, url, payload: payload as any, headers: auth(t) });
const submit = async (over: Record<string, unknown> = {}) => (await app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload(over) as any })).json().registration;

const ids: Record<string, string> = {};

beforeAll(async () => {
  ({ app, db, editionId } = await makeApp());
  tok = {} as any;
  for (const role of ["viewer", "admin", "finance", "super_admin"] as const) {
    await createAdmin(db, role);
    tok[role] = await loginAs(app, `${role}@test.example`);
  }
  // synthetic dataset
  ids.a = (await submit({ school_name: "Alpha Academy", school_code: "00100", province: "Kigali", district: "Gasabo", sector: "Kinyinya", school_type: "Public", students_p5_p6: 5, students_s1_s3: 5, students_s4_s5: 5 })).id;
  ids.b = (await submit({ school_name: "Beta College", school_code: "00200", province: "Southern", district: "Huye", sector: "Ngoma", school_type: "Private", first_name: "Zacharie", mathematics_teacher_last_name: "Nkurunziza", students_p5_p6: 1, students_s1_s3: 2, students_s4_s5: 3 })).id;
  ids.c = (await submit({ school_name: "Gamma School", school_code: "00300", province: "Northern", district: "Musanze", sector: "Muhoza", school_type: "Government Aided", email_address: "gamma.contact@example.org", students_p5_p6: 0, students_s1_s3: 0, students_s4_s5: 0, school_bank_account: "55555555555" })).id;
  ids.dup = (await submit({ school_name: "Alpha Academy Annex", school_code: "00100", students_p5_p6: 1 })).id; // same code as Alpha
  ids.sameName = (await submit({ school_name: "ALPHA  academy", school_code: "00999", students_p5_p6: 2 })).id; // same name+district as Alpha
});

describe("authentication", () => {
  it("logs in and returns a bearer token; /me works", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ADMIN@test.example", password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token_type: "Bearer", user: { role: "admin", email: "admin@test.example" } });
    expect(JSON.stringify(res.json())).not.toContain("password_hash");
    const me = await get("/api/auth/me", res.json().token);
    expect(me.json()).toMatchObject({ role: "admin" });
  });
  it("rejects wrong passwords and unknown users identically", async () => {
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.example", password: "nope-nope-nope" } });
    const unknown = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ghost@test.example", password: "nope-nope-nope" } });
    expect(wrong.statusCode).toBe(401); expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });
  it("locks an account after repeated failures, even for the right password", async () => {
    await createAdmin(db, "viewer", "locky@test.example");
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "locky@test.example", password: "wrong-wrong-wrong" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "locky@test.example", password: PASSWORD } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("account_locked");
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='auth.account_locked'")).rowCount).toBe(1);
  });
  it("throttles login attempts per client", async () => {
    const limited = await makeApp({ loginRateLimitMax: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await limited.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@test.example", password: "x".repeat(14) } })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
  });
  it("validates login input", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: {} })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ["a"], password: { $ne: 1 } } as any })).statusCode).toBe(422);
  });
  it("rejects disabled users and revoked tokens immediately", async () => {
    await createAdmin(db, "admin", "temp@test.example");
    const t = await loginAs(app, "temp@test.example");
    expect((await get("/api/school-registrations", t)).statusCode).toBe(200);
    await db.query("UPDATE admin_users SET token_version = token_version + 1 WHERE email='temp@test.example'");
    expect((await get("/api/school-registrations", t)).statusCode).toBe(401);
    const t2 = await loginAs(app, "temp@test.example");
    await db.query("UPDATE admin_users SET is_active = false WHERE email='temp@test.example'");
    expect((await get("/api/school-registrations", t2)).statusCode).toBe(401);
  });
  it("rejects missing, malformed, tampered, expired, wrong-secret and alg=none tokens on every admin route", async () => {
    const id = ids.a!;
    const routes: [string, string][] = [
      ["GET", "/api/school-registrations"], ["GET", `/api/school-registrations/${id}`], ["PATCH", `/api/school-registrations/${id}`],
      ["PATCH", `/api/school-registrations/${id}/status`], ["GET", "/api/school-registrations/export"],
      ["GET", "/api/school-registrations/statistics"], ["GET", `/api/school-registrations/${id}/audit`], ["GET", "/api/auth/me"],
    ];
    const userId = (await db.query<{ id: string }>("SELECT id FROM admin_users WHERE email='super_admin@test.example'")).rows[0]!.id;
    const expired = await signToken("test-secret-test-secret-test-secret-123456", { sub: userId, role: "super_admin", tv: 0 }, -10);
    const wrongSecret = await signToken("another-secret-another-secret-123456789", { sub: userId, role: "super_admin", tv: 0 }, 3600);
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId, role: "super_admin", tv: 0 })).toString("base64url")}.`;
    const tampered = tok.viewer.slice(0, -3) + "AAA";
    for (const [method, url] of routes) {
      for (const header of [undefined, "Bearer", "Bearer garbage", `Bearer ${expired}`, `Bearer ${wrongSecret}`, `Bearer ${none}`, `Bearer ${tampered}`, `Basic ${tok.admin}`]) {
        const res = await app.inject({ method: method as any, url, headers: header ? { authorization: header } : {}, payload: method === "PATCH" ? { first_name: "X" } : undefined });
        expect(res.statusCode, `${method} ${url} ${header?.slice(0, 20)}`).toBe(401);
      }
    }
  });
  it("does not trust a role claim inside the token over the database role", async () => {
    const userId = (await db.query<{ id: string }>("SELECT id FROM admin_users WHERE email='viewer@test.example'")).rows[0]!.id;
    const forged = await signToken("test-secret-test-secret-test-secret-123456", { sub: userId, role: "super_admin", tv: 0 }, 3600);
    const res = await send("PATCH", `/api/school-registrations/${ids.a}`, { first_name: "Hacker" }, forged);
    expect(res.statusCode).toBe(403);
  });
});

describe("authorization (role-based)", () => {
  it("viewer can read but not modify, export, or audit", async () => {
    expect((await get("/api/school-registrations", tok.viewer)).statusCode).toBe(200);
    expect((await get("/api/school-registrations/statistics", tok.viewer)).statusCode).toBe(200);
    expect((await send("PATCH", `/api/school-registrations/${ids.a}`, { first_name: "X" }, tok.viewer)).statusCode).toBe(403);
    expect((await send("PATCH", `/api/school-registrations/${ids.a}/status`, { status: "approved" }, tok.viewer)).statusCode).toBe(403);
    expect((await get("/api/school-registrations/export", tok.viewer)).statusCode).toBe(403);
    expect((await get(`/api/school-registrations/${ids.a}/audit`, tok.viewer)).statusCode).toBe(403);
  });
  it("finance can read/export/edit bank details but cannot change status or other fields", async () => {
    expect((await send("PATCH", `/api/school-registrations/${ids.a}/status`, { status: "approved" }, tok.finance)).statusCode).toBe(403);
    expect((await send("PATCH", `/api/school-registrations/${ids.a}`, { first_name: "X" }, tok.finance)).statusCode).toBe(403);
    expect((await get("/api/school-registrations/export?include_bank=true", tok.finance)).statusCode).toBe(200);
  });
  it("returns 404 (not a 500) for unknown or malformed ids", async () => {
    for (const id of ["00000000-0000-0000-0000-000000000000", "not-a-uuid", "1' OR '1'='1"]) {
      expect((await get(`/api/school-registrations/${encodeURIComponent(id)}`)).statusCode, id).toBe(404);
      expect((await send("PATCH", `/api/school-registrations/${encodeURIComponent(id)}`, { first_name: "X" })).statusCode, id).toBe(404);
      expect((await send("PATCH", `/api/school-registrations/${encodeURIComponent(id)}/status`, { status: "approved" })).statusCode, id).toBe(404);
    }
  });
});

describe("bank data protection", () => {
  it("omits bank fields entirely for roles without bank access", async () => {
    for (const role of ["viewer", "admin"] as const) {
      const list = (await get("/api/school-registrations", tok[role])).json().data[0];
      const detail = (await get(`/api/school-registrations/${ids.c}`, tok[role])).json();
      for (const body of [list, detail]) {
        for (const f of ["school_bank_name", "school_bank_account", "teacher_bank_name", "mathematics_teacher_account_number"]) expect(body, `${role}.${f}`).not.toHaveProperty(f);
      }
      expect(JSON.stringify(detail)).not.toContain("55555555555");
      expect((await get(`/api/school-registrations/${ids.c}?reveal_bank=true`, tok[role])).statusCode).toBe(403);
    }
  });
  it("masks account numbers in lists and details for bank-authorised roles", async () => {
    const list = (await get("/api/school-registrations?q=Gamma", tok.finance)).json().data[0];
    expect(list.school_bank_account).toBe("********555");
    expect(list.school_bank_account).not.toContain("5555");
    expect(list.mathematics_teacher_account_number).toMatch(/^\*+432$/);
    expect(JSON.stringify((await get(`/api/school-registrations/${ids.c}`, tok.finance)).json())).not.toContain("55555555555");
  });
  it("reveals full numbers only on explicit request, and audits it", async () => {
    const d = (await get(`/api/school-registrations/${ids.c}?reveal_bank=true`, tok.finance)).json();
    expect(d.school_bank_account).toBe("55555555555");
    const log = (await db.query("SELECT actor_label FROM audit_log WHERE action='registration.bank_details_viewed' AND entity_id=$1", [ids.c])).rows;
    expect(log).toEqual([{ actor_label: "finance@test.example" }]);
  });
  it("blocks bank edits for admin role; allows finance; never writes values to the audit log", async () => {
    expect((await send("PATCH", `/api/school-registrations/${ids.b}`, { school_bank_account: "9999999999" }, tok.admin)).statusCode).toBe(403);
    const ok = await send("PATCH", `/api/school-registrations/${ids.b}`, { school_bank_account: "9999999999", school_bank_name: "New Bank" }, tok.finance);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().school_bank_account).toBe("*******999");
    const audit = JSON.stringify((await db.query("SELECT changes FROM audit_log WHERE action='registration.updated' AND entity_id=$1", [ids.b])).rows);
    expect(audit).not.toContain("9999999999");
    expect(audit).not.toContain("New Bank");
    expect(audit).toContain("changed");
  });
  it("does not include bank columns in the default export and gates include_bank", async () => {
    const plain = (await get("/api/school-registrations/export", tok.admin)).body;
    expect(plain).not.toContain("Bank");
    expect(plain).not.toContain("55555555555");
    expect((await get("/api/school-registrations/export?include_bank=true", tok.admin)).statusCode).toBe(403);
    const full = (await get("/api/school-registrations/export?include_bank=true&excel_safe=false", tok.finance)).body;
    expect(full).toContain("School Bank Account");
    expect(full).toContain("55555555555");
  });
});

describe("GET /api/school-registrations (list)", () => {
  const list = async (qs = "", t = tok.admin) => (await get(`/api/school-registrations${qs}`, t)).json();

  it("paginates server-side with totals", async () => {
    const p1 = await list("?page_size=2&page=1&sort=registration_reference&order=asc");
    expect(p1.data).toHaveLength(2);
    expect(p1.pagination).toEqual({ page: 1, page_size: 2, total: 5, total_pages: 3 });
    const p3 = await list("?page_size=2&page=3&sort=registration_reference&order=asc");
    expect(p3.data).toHaveLength(1);
    const all = [...p1.data, ...(await list("?page_size=2&page=2&sort=registration_reference&order=asc")).data, ...p3.data].map((r: any) => r.id);
    expect(new Set(all).size).toBe(5);
    expect((await list("?page=99")).data).toEqual([]);
  });
  it("returns the headteacher fields, estimates and computed totals", async () => {
    const r = (await list("?q=Beta")).data[0];
    expect(r).toMatchObject({ head_teacher_first_name: "Jean", head_teacher_last_name: "Mugabo", head_teacher_email: "head@example.org", head_teacher_phone: "+250722000111",
      students_p5_p6: 1, students_s1_s3: 2, students_s4_s5: 3, total_estimated_students: 6, province: "Southern Province", district: "Huye", sector: "Ngoma" });
    expect(r).not.toHaveProperty("request_fingerprint");
    expect(r).not.toHaveProperty("legacy_raw");
    expect(r).not.toHaveProperty("idempotency_key");
  });
  it.each([
    ["school name", "?q=alpha%20academy", 3],
    ["school code", "?q=00300", 1],
    ["leading-zero code", "?q=00200", 1],
    ["registration reference", "", 1],
    ["registering contact first name", "?q=Zacharie", 1],
    ["maths teacher name", "?q=Nkurunziza", 1],
    ["email", "?q=gamma.contact%40example", 1],
    ["full name across columns (every synthetic row has contact Aline Uwase)", "?q=Aline%20Uwase", 5],
    ["name + school tokens combine with AND", "?q=Aline%20Gamma", 1],
    ["no match", "?q=zzzzzz", 0],
  ])("searches by %s", async (name, qs, n) => {
    if (name === "registration reference") {
      const ref = (await list("?q=Gamma")).data[0].registration_reference;
      expect((await list(`?q=${ref}`)).data).toHaveLength(1);
      expect((await list(`?q=${ref.toLowerCase()}`)).data).toHaveLength(1);
      return;
    }
    expect((await list(qs)).data).toHaveLength(n);
  });
  it("treats LIKE wildcards and SQL as literals", async () => {
    expect((await list("?q=%25")).data).toHaveLength(0);
    expect((await list("?q=_")).data).toHaveLength(0);
    expect((await list("?q=%27%3B%20DROP%20TABLE%20school_registrations%3B--")).data).toHaveLength(0);
    expect((await list("")).pagination.total).toBe(5);
  });
  it("filters by edition, province, district, sector, type and status", async () => {
    expect((await list(`?edition_id=${editionId}`)).pagination.total).toBe(5);
    expect((await list(`?edition_id=${(await createEdition(db, { year: 2099, current: false }))}`)).pagination.total).toBe(0);
    expect((await list("?province=Southern")).data.map((r: any) => r.school_name)).toEqual(["Beta College"]);
    expect((await list("?province=Southern%20Province")).pagination.total).toBe(1);
    expect((await list("?district=musanze")).pagination.total).toBe(1);
    expect((await list("?sector=Muhoza")).pagination.total).toBe(1);
    const distId = (await db.query<{ id: string }>("SELECT id FROM districts WHERE name='Huye'")).rows[0]!.id;
    expect((await list(`?district=${distId}`)).pagination.total).toBe(1);
    expect((await list("?school_type=Private")).pagination.total).toBe(1);
    expect((await list("?school_type=Government%20Aided")).pagination.total).toBe(1);
    expect((await list("?status=pending")).pagination.total).toBe(5);
    expect((await list("?status=approved")).pagination.total).toBe(0);
    expect((await list("?province=Kigali&school_type=Public&q=Alpha")).pagination.total).toBe(3);
  });
  it("filters by created date range", async () => {
    expect((await list("?created_from=2000-01-01&created_to=2001-01-01")).pagination.total).toBe(0);
    expect((await list("?created_from=2000-01-01")).pagination.total).toBe(5);
  });
  it("sorts by whitelisted columns only", async () => {
    expect((await list("?sort=school_name&order=asc")).data[0].school_name.toLowerCase()).toBe("alpha academy");
    expect((await list("?sort=school_name&order=desc")).data[0].school_name).toBe("Gamma School");
    expect((await list("?sort=total_estimated_students&order=desc")).data[0].total_estimated_students).toBe(22);
    expect((await get("/api/school-registrations?sort=id;DROP TABLE x")).statusCode).toBe(422);
  });
  it("validates query parameters", async () => {
    for (const qs of ["?page=0", "?page=abc", "?page_size=101", "?page_size=-1", "?status=bogus", "?school_type=x", "?edition_id=nope", "?incomplete=maybe", "?created_from=yesterday", "?order=sideways"])
      expect((await get(`/api/school-registrations${qs}`)).statusCode, qs).toBe(422);
  });
  it("flags potential duplicates (same code, or same name within the district) without hiding anything", async () => {
    const dups = await list("?potential_duplicates=true&sort=school_name&order=asc");
    expect(dups.data.map((r: any) => r.school_name).sort()).toEqual(["ALPHA academy", "Alpha Academy", "Alpha Academy Annex"]);
    expect(dups.data.every((r: any) => r.has_potential_duplicates)).toBe(true);
    const detail = (await get(`/api/school-registrations/${ids.a}`)).json();
    const byRef = Object.fromEntries(detail.potential_duplicates.map((d: any) => [d.id, d.reasons]));
    expect(byRef[ids.dup!]).toEqual(["same_school_code"]);
    expect(byRef[ids.sameName!]).toEqual(["same_school_name_and_district"]);
    expect((await list("?potential_duplicates=false")).pagination.total).toBe(5);
    expect(detail.potential_duplicates.map((d: any) => d.id)).not.toContain(ids.b);
  });
  it("shows the same school's history across editions and never flags other editions as duplicates", async () => {
    const e2 = await createEdition(db, { year: 2098, current: false, slug: "2098" });
    await db.query("UPDATE school_registrations SET competition_edition_id = $2 WHERE id = $1", [ids.dup, e2]);
    const detail = (await get(`/api/school-registrations/${ids.a}`)).json();
    expect(detail.potential_duplicates.map((d: any) => d.id)).not.toContain(ids.dup);
    expect(detail.school_registration_history.map((h: any) => h.id)).toContain(ids.dup);
    await db.query("UPDATE school_registrations SET competition_edition_id = $2 WHERE id = $1", [ids.dup, editionId]);
  });
  it("reports incomplete records (missing required data)", async () => {
    expect((await list("?incomplete=true")).pagination.total).toBe(0);
    expect((await list("?incomplete=false")).pagination.total).toBe(5);
    const d = (await get(`/api/school-registrations/${ids.a}`)).json();
    expect(d).toMatchObject({ is_incomplete: false, missing_fields: [] });
  });
});

describe("GET /api/school-registrations/:id", () => {
  it("returns the full record", async () => {
    const res = await get(`/api/school-registrations/${ids.a}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: ids.a, school_name: "Alpha Academy", school_code: "00100", edition_name: "Test Olympiad 2026", status: "pending",
      questions_comments_concerns_feedback: "Is there a fee?", additional_information: "We have a computer lab.",
      test_delivery_email: "tests@example.org", mathematics_teacher_email: "claire@example.org",
    });
  });
});

describe("PATCH /api/school-registrations/:id", () => {
  it("persists permitted updates, normalizes, recalculates totals, and audits the diff", async () => {
    const res = await send("PATCH", `/api/school-registrations/${ids.c}`, { phone_contact: "0789999999", students_p5_p6: "7", head_teacher_last_name: "Hakizimana", additional_information: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phone_contact: "+250789999999", students_p5_p6: 7, total_estimated_students: 7, head_teacher_last_name: "Hakizimana", additional_information: null });
    const again = (await get(`/api/school-registrations/${ids.c}`)).json();
    expect(again.total_estimated_students).toBe(7);
    expect(again.updated_at >= again.created_at).toBe(true);
    const audit = (await get(`/api/school-registrations/${ids.c}/audit`)).json().data;
    const upd = audit.find((a: any) => a.action === "registration.updated");
    expect(upd.actor_label).toBe("super_admin@test.example");
    expect(upd.changes.phone_contact.to).toBe("+250789999999");
    expect(upd.changes.students_p5_p6).toEqual({ from: 0, to: 7 });
  });
  it("validates updates and rejects system/unknown fields", async () => {
    for (const body of [{ status: "approved" }, { total_estimated_students: 1 }, { id: "x" }, { registration_reference: "x" }, { competition_edition_id: "x" }, {}, { email_address: "bad" }, { students_s1_s3: -1 }, { first_name: "" }])
      expect((await send("PATCH", `/api/school-registrations/${ids.a}`, body)).statusCode, JSON.stringify(body)).toBe(422);
  });
  it("validates location changes against the hierarchy and applies valid ones", async () => {
    expect((await send("PATCH", `/api/school-registrations/${ids.a}`, { district: "Musanze" })).statusCode).toBe(422); // Kigali province, Musanze district
    expect((await send("PATCH", `/api/school-registrations/${ids.a}`, { sector: "Muhoza" })).statusCode).toBe(422);
    const ok = await send("PATCH", `/api/school-registrations/${ids.a}`, { province: "Northern", district: "Musanze", sector: "Muhoza" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ province: "Northern Province", district: "Musanze", sector: "Muhoza" });
    await send("PATCH", `/api/school-registrations/${ids.a}`, { province: "Kigali", district: "Gasabo", sector: "Kinyinya" });
  });
  it("is a no-op (no audit entry) when nothing changes", async () => {
    const before = (await db.query("SELECT count(*)::int n FROM audit_log")).rows[0]!.n;
    expect((await send("PATCH", `/api/school-registrations/${ids.b}`, { first_name: "Zacharie" })).statusCode).toBe(200);
    expect((await db.query("SELECT count(*)::int n FROM audit_log")).rows[0]!.n).toBe(before);
  });
  it("re-links the school when the school code changes", async () => {
    const before = (await db.query<{ school_id: string }>("SELECT school_id FROM school_registrations WHERE id=$1", [ids.sameName])).rows[0]!.school_id;
    await send("PATCH", `/api/school-registrations/${ids.sameName}`, { school_code: "00100" });
    const after = (await db.query<{ school_id: string }>("SELECT school_id FROM school_registrations WHERE id=$1", [ids.sameName])).rows[0]!.school_id;
    expect(after).not.toBe(before);
    await send("PATCH", `/api/school-registrations/${ids.sameName}`, { school_code: "00999" });
  });
});

describe("PATCH /api/school-registrations/:id/status", () => {
  it("changes status, records an audit entry and keeps data intact", async () => {
    const res = await send("PATCH", `/api/school-registrations/${ids.b}/status`, { status: "verified", note: "Checked with school" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "verified", status_note: "Checked with school" });
    const audit = (await get(`/api/school-registrations/${ids.b}/audit`, tok.admin)).json().data.find((a: any) => a.action === "registration.status_changed");
    expect(audit.changes).toEqual({ from: "pending", to: "verified", note: "Checked with school" });
    expect((await get("/api/school-registrations?status=verified")).json().pagination.total).toBe(1);
  });
  it("rejects invalid statuses, missing notes on rejection, and no-op changes", async () => {
    expect((await send("PATCH", `/api/school-registrations/${ids.b}/status`, { status: "super-approved" })).statusCode).toBe(422);
    expect((await send("PATCH", `/api/school-registrations/${ids.b}/status`, {})).statusCode).toBe(422);
    expect((await send("PATCH", `/api/school-registrations/${ids.b}/status`, { status: "rejected" })).statusCode).toBe(422);
    expect((await send("PATCH", `/api/school-registrations/${ids.b}/status`, { status: "verified" })).statusCode).toBe(409);
    expect((await send("PATCH", `/api/school-registrations/${ids.b}/status`, { status: "rejected", note: { x: 1 } })).statusCode).toBe(422);
  });
  it("lets the admin role change status (least privilege still permits the review workflow)", async () => {
    expect((await send("PATCH", `/api/school-registrations/${ids.c}/status`, { status: "under_review" }, tok.admin)).statusCode).toBe(200);
  });
});

describe("GET /api/school-registrations/statistics", () => {
  it("returns aggregates only (no personal data) and excludes rejected/withdrawn from student totals", async () => {
    await send("PATCH", `/api/school-registrations/${ids.sameName}/status`, { status: "rejected", note: "duplicate" });
    const s = (await get("/api/school-registrations/statistics", tok.viewer)).json();
    expect(s.totals).toMatchObject({ registrations: 5, active_registrations: 4, distinct_schools: 3 });
    const expected = (await db.query("SELECT sum(students_p5_p6)::int a, sum(students_s1_s3)::int b, sum(students_s4_s5)::int c, sum(total_estimated_students)::int t FROM school_registrations WHERE status NOT IN ('rejected','withdrawn')")).rows[0]!;
    expect(s.totals).toMatchObject({ students_p5_p6: expected.a, students_s1_s3: expected.b, students_s4_s5: expected.c, total_estimated_students: expected.t });
    expect(s.totals.total_estimated_students).toBe(s.totals.students_p5_p6 + s.totals.students_s1_s3 + s.totals.students_s4_s5);
    expect(s.by_status.find((x: any) => x.key === "rejected").registrations).toBe(1);
    expect(s.by_province.map((x: any) => x.key).sort()).toEqual(["Kigali City", "Northern Province", "Southern Province"]);
    expect(s.by_school_type.length).toBeGreaterThan(0);
    const text = JSON.stringify(s);
    for (const pii of ["example.org", "Aline", "0788", "Jean", "5555"]) expect(text).not.toContain(pii);
    await send("PATCH", `/api/school-registrations/${ids.sameName}/status`, { status: "pending" });
  });
  it("defaults to the current edition, supports edition_id and 'all'", async () => {
    expect((await get("/api/school-registrations/statistics")).json().totals.registrations).toBe(5);
    expect((await get("/api/school-registrations/statistics?edition_id=all")).json().totals.registrations).toBe(5);
    const other = await createEdition(db, { year: 2097, slug: "2097", current: false });
    expect((await get(`/api/school-registrations/statistics?edition_id=${other}`)).json().totals.registrations).toBe(0);
    expect((await get("/api/school-registrations/statistics?edition_id=zzz")).statusCode).toBe(422);
  });
});

describe("GET /api/school-registrations/export", () => {
  const parse = (csv: string) => (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).trim().split("\r\n");
  it("exports filtered rows as CSV with attachment headers, preserving leading zeros for Excel", async () => {
    const res = await get("/api/school-registrations/export?q=Beta", tok.admin);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="school-registrations-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = parse(res.body);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Headteacher First Name");
    expect(lines[1]).toContain('"=""00200"""'); // school code as text
    expect(lines[1]).toContain('"=""+250788123456"""');
    expect(lines[1]).toContain("Beta College");
  });
  it("can export raw values for machine consumption", async () => {
    const lines = parse((await get("/api/school-registrations/export?q=Beta&excel_safe=false", tok.admin)).body);
    expect(lines[1]!.split(",")).toContain("00200");
    expect(lines[1]).toContain("+250788123456");
    expect(lines[1]).not.toContain('=""');
  });
  it("respects the same filters and exports every matching row (not just a page)", async () => {
    expect(parse((await get("/api/school-registrations/export?province=Kigali")).body)).toHaveLength(1 + 3);
    expect(parse((await get("/api/school-registrations/export")).body)).toHaveLength(1 + 5);
    expect((await get("/api/school-registrations/export?status=bogus")).statusCode).toBe(422);
  });
  it("neutralizes spreadsheet formula injection and quotes commas, quotes and newlines", async () => {
    const r = await submit({ school_code: "7001", school_name: "=HYPERLINK(\"http://evil\")", additional_information: "+cmd|' /C calc'!A0\nsecond \"line\", with comma", questions_comments_concerns_feedback: "@SUM(1+1)" });
    const body = (await get(`/api/school-registrations/export?q=${r.registration_reference}`)).body;
    expect(body).toContain("'=HYPERLINK");
    expect(body).toContain("\"'+cmd|' /C calc'!A0\nsecond \"\"line\"\", with comma\"");
    expect(body).toContain("'@SUM(1+1)");
    expect(body).not.toMatch(/(^|,)=HYPERLINK/);
    expect(body.charCodeAt(0)).toBe(0xfeff);
  });
  it("records exports in the audit trail", async () => {
    await get("/api/school-registrations/export?province=Kigali", tok.admin);
    const row = (await db.query("SELECT actor_label, changes FROM audit_log WHERE action='registration.exported' ORDER BY id DESC LIMIT 1")).rows[0]!;
    expect(row.actor_label).toBe("admin@test.example");
    const kigaliId = (await db.query<{ id: string }>("SELECT id FROM provinces WHERE name LIKE 'Kigali%'")).rows[0]!.id;
    expect(row.changes).toMatchObject({ include_bank: false, filters: { province: kigaliId } });
  });
  it("preserves non-ASCII names", async () => {
    const r = await submit({ school_code: "7002", first_name: "Zoë", last_name: "N’Dayisaba" });
    expect((await get(`/api/school-registrations/export?q=${r.registration_reference}`)).body).toContain("Zoë,N’Dayisaba");
  });
});

describe("audit trail", () => {
  it("records submission, update, status, export and bank view; entries cannot be altered", async () => {
    const actions = new Set((await db.query<{ action: string }>("SELECT DISTINCT action FROM audit_log")).rows.map((r) => r.action));
    for (const a of ["registration.created", "registration.updated", "registration.status_changed", "registration.exported", "registration.bank_details_viewed", "auth.login"])
      expect(actions.has(a), a).toBe(true);
    await expect(db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
  });
});
