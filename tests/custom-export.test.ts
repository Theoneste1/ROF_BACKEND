/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAdmin, loginAs, makeApp, validPayload } from "./helpers.js";
import type { Db } from "../src/db.js";
import { iterateExportRows } from "../src/registrations.js";
import { EXPORT_FIELDS } from "../src/exportFields.js";

let app: FastifyInstance; let db: Db;
let tok: Record<"viewer" | "admin" | "finance" | "super_admin", string>;
const ids: Record<string, string> = {};
const URL = "/api/school-registrations/export";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (payload: unknown, t = tok.admin) => app.inject({ method: "POST", url: URL, payload: payload as any, headers: auth(t) });
const lines = (csv: string) => (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).trim().split("\r\n");
const submit = async (over: Record<string, unknown>) =>
  (await app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload(over) as any })).json().registration;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  tok = {} as any;
  for (const role of ["viewer", "admin", "finance", "super_admin"] as const) {
    await createAdmin(db, role);
    tok[role] = await loginAs(app, `${role}@test.example`);
  }
  ids.a = (await submit({ school_name: "Alpha Academy", school_code: "00100", district: "Gasabo", sector: "Kinyinya", mathematics_teacher_first_name: "Claire", mathematics_teacher_last_name: "Ingabire", mathematics_teacher_account_number: "00011122233" })).id;
  ids.b = (await submit({ school_name: "Beta College", school_code: "00200", province: "Southern", district: "Huye", sector: "Ngoma", teacher_bank_name: "", mathematics_teacher_account_number: "" })).id;
  ids.c = (await submit({ school_name: "Gamma School", school_code: "00300", province: "Northern", district: "Musanze", sector: "Muhoza" })).id;
});

describe("GET /api/school-registrations/export-fields", () => {
  const cats = async (t: string) => (await app.inject({ method: "GET", url: `${URL}-fields`, headers: auth(t) })).json().categories as any[];
  it("lists categories and fields; bank fields only for roles with bank:read", async () => {
    const admin = await cats(tok.admin);
    expect(admin.map((c) => c.key)).toEqual(expect.arrayContaining(["teacher", "school", "head_teacher", "contact"]));
    expect(admin.flatMap((c) => c.fields).some((f: any) => f.sensitive)).toBe(false);
    expect(admin.map((c) => c.key)).not.toContain("teacher_bank");
    const finance = await cats(tok.finance);
    expect(finance.find((c) => c.key === "teacher_bank").fields.map((f: any) => f.key)).toEqual(["teacher_bank_name", "mathematics_teacher_account_number"]);
    expect((await cats(tok.super_admin)).flatMap((c) => c.fields)).toHaveLength(EXPORT_FIELDS.length);
  });
  it("needs the export permission and a valid token", async () => {
    expect((await app.inject({ method: "GET", url: `${URL}-fields`, headers: auth(tok.viewer) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${URL}-fields` })).statusCode).toBe(401);
  });
});

describe("POST /api/school-registrations/export", () => {
  it("exports only the chosen fields, in the chosen order, with joined school and headteacher data", async () => {
    const res = await post({ fields: ["school_name", "mathematics_teacher_full_name", "school_address", "head_teacher_full_name", "school_code"], filters: { q: "Alpha" }, excel_safe: false });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="registrations-export-\d{4}-\d{2}-\d{2}\.csv"$/);
    const [head, row, ...rest] = lines(res.body);
    expect(head).toBe("School Name,Teacher Full Name,School Address,Headteacher Full Name,School Code");
    expect(row).toMatch(/^Alpha Academy,Claire Ingabire,"Kinyinya, Gasabo, (City of )?Kigali[^"]*",Jean Mugabo,00100$/);
    expect(rest).toHaveLength(0);
  });
  it("keeps codes and phone numbers as text for Excel by default", async () => {
    const [, row] = lines((await post({ fields: ["school_code"], filters: { q: "Alpha" } })).body);
    expect(row).toBe('"=""00100"""');
  });
  it("returns JSON rows for spreadsheet building in the browser", async () => {
    const res = await post({ fields: ["registration_reference", "total_estimated_students"], format: "json" });
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.columns).toEqual([{ key: "registration_reference", label: "Registration Reference" }, { key: "total_estimated_students", label: "Total Estimated Students" }]);
    expect(body.rows).toHaveLength(3);
    expect(typeof body.rows[0][1]).toBe("number");
  });
  it("previews a few rows with the total count", async () => {
    const body = (await post({ fields: ["school_name"], preview: true })).json();
    expect(body).toMatchObject({ total: 3, columns: [{ key: "school_name" }] });
    expect(body.rows.map((r: any[]) => r[0])).toEqual(["Alpha Academy", "Beta College", "Gamma School"]);
  });

  it("rejects unknown, repeated, empty and malformed field lists", async () => {
    for (const fields of [["school_name", "password_hash"], ["school_name", "school_name"], [], "school_name", [1], undefined]) {
      const res = await post({ fields });
      expect(res.statusCode, JSON.stringify(fields)).toBe(422);
      expect(res.json().error.fields.fields).toBeTruthy();
    }
  });
  it("refuses bank fields to roles without bank:read even when the request is edited by hand", async () => {
    for (const f of ["teacher_bank_name", "mathematics_teacher_account_number", "school_bank_name", "school_bank_account"]) {
      expect((await post({ fields: ["school_name", f] }, tok.admin)).statusCode, f).toBe(403);
      expect((await post({ fields: ["school_name", f], preview: true }, tok.admin)).statusCode, f).toBe(403);
    }
    expect((await post({ fields: ["school_name"] }, tok.viewer)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: URL, payload: { fields: ["school_name"] } })).statusCode).toBe(401);
  });
  it("exports full bank values to authorised roles", async () => {
    const [head, row] = lines((await post({ fields: ["school_name", "teacher_bank_name", "mathematics_teacher_account_number"], filters: { q: "Alpha" }, excel_safe: false }, tok.finance)).body);
    expect(head).toBe("School Name,Teacher Bank Name,Teacher Bank Account Number");
    expect(row).toBe("Alpha Academy,Other Bank,00011122233");
  });

  it("applies filters: district, complete teacher banking, date range and selected rows", async () => {
    const names = async (body: Record<string, unknown>) =>
      (await post({ fields: ["school_name"], format: "json", ...body })).json().rows.map((r: any[]) => r[0]);
    expect(await names({ filters: { district: "Huye" } })).toEqual(["Beta College"]);
    expect(await names({ filters: { bank_complete: true } })).toEqual(["Alpha Academy", "Gamma School"]);
    expect(await names({ filters: { bank_complete: false } })).toEqual(["Beta College"]);
    expect(await names({ filters: { created_from: "2000-01-01", created_to: "2100-01-01" } })).toHaveLength(3);
    expect(await names({ filters: { created_from: "2100-01-01" } })).toEqual([]);
    expect(await names({ ids: [ids.c, ids.a] })).toEqual(["Alpha Academy", "Gamma School"]);
    expect(await names({ ids: [ids.c], filters: { district: "Huye" } })).toEqual([]);
  });
  it("validates filters, ids and options", async () => {
    const bad = [
      { filters: { district: "Huye", password: "x" } }, { filters: { status: "bogus" } }, { filters: { district: ["Huye"] } },
      { filters: "district=Huye" }, { ids: ["not-a-uuid"] }, { ids: [] }, { format: "pdf" }, { preview: "yes" },
    ];
    for (const extra of bad) expect((await post({ fields: ["school_name"], ...extra })).statusCode, JSON.stringify(extra)).toBe(422);
  });

  it("audits every export with its fields and filters, and sensitive previews, without bank values", async () => {
    await post({ fields: ["school_name", "teacher_bank_name", "mathematics_teacher_account_number"], filters: { district: "Gasabo" } }, tok.super_admin);
    const exp = (await db.query("SELECT actor_label, changes FROM audit_log WHERE action='registration.exported' ORDER BY id DESC LIMIT 1")).rows[0]!;
    expect(exp.actor_label).toBe("super_admin@test.example");
    expect(exp.changes).toMatchObject({ rows: 1, include_bank: true, format: "csv", fields: ["school_name", "teacher_bank_name", "mathematics_teacher_account_number"] });
    expect(JSON.stringify(exp.changes)).not.toContain("00011122233");

    const before = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='registration.export_previewed'")).rows[0]!.n;
    await post({ fields: ["school_name"], preview: true }, tok.super_admin);
    await post({ fields: ["teacher_bank_name"], preview: true }, tok.super_admin);
    const after = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='registration.export_previewed'")).rows[0]!.n;
    expect(after - before).toBe(1);
  });
});

describe("iterateExportRows", () => {
  it("walks every row exactly once in batches, even when timestamps tie", async () => {
    await db.query("UPDATE school_registrations SET created_at = '2026-05-01T10:00:00.123456Z'");
    const seen: string[] = [];
    for await (const batch of iterateExportRows(db, {}, 50_000, 2)) {
      expect(batch.length).toBeLessThanOrEqual(2);
      seen.push(...batch.map((r) => r.id));
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual([...seen].sort());
  });
  it("stops at the limit", async () => {
    let n = 0;
    for await (const batch of iterateExportRows(db, {}, 2, 1)) n += batch.length;
    expect(n).toBe(2);
  });
});
