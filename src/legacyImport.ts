import crypto from "node:crypto";
import type { Db } from "./db.js";
import { LocationService, normKey } from "./locations.js";
import { SCHOOL_ROLES, SCHOOL_TYPES, normalizePhone } from "./validation.js";

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const HEADERS = {
  timestamp: "Timestamp", name: "Your full Name", email: "Email Address", phone: "Phone contact",
  school: "School Name", code: "School Code", type: "School Type",
  province: "Choose school Province", district: "Choose School District", sector: "School Sector",
  bankName: "School Bank Name", bankAccount: "School Bank Account",
  teacherName: "Mathematics Teachers's full Name", teacherEmail: "Mathematics teachers Email address",
  teacherPhone: "Mathematics teachers Phone contact", teacherBank: "Teacher's Bank Name",
  teacherAccount: "Mathematics Teacher's Account Number", headEmail: "Head teacher's email address",
  role: "What is your role at school?",
  p56: "How many students from P5 to P6 from your school who will attend the competition?",
  s13: "How many student from S1 to S3  from your school who will attend the competition?",
  s45: "How many number of students from S4 to S5 from your school who will attend the competition?",
  testEmail: "Could you confirm which email address on which we should send the test",
  comments: "Any question/comment/concern/feedbacks", extra: "Anything you want us to know",
} as const;

export interface ImportReport { total: number; imported: number; alreadyImported: number; skipped: { line: number; reason: string }[] }

/**
 * Imports rows of the legacy Google Sheet as `is_legacy` registrations.
 * Nothing is invented: names stay as the single submitted string, fields the old form
 * never collected (head teacher name/phone) stay NULL, and the original row is kept in legacy_raw.
 * Re-running is safe: each row is keyed by a hash of its content.
 */
export async function importLegacyCsv(db: Db, locations: LocationService, csv: string, editionSlug: string, apply: boolean): Promise<ImportReport> {
  const rows = parseCsv(csv);
  const report: ImportReport = { total: Math.max(rows.length - 1, 0), imported: 0, alreadyImported: 0, skipped: [] };
  if (rows.length < 2) return report;
  const header = rows[0]!.map((h) => h.trim());
  const idx = (h: string) => header.indexOf(h);
  const ed = (await db.query<{ id: string }>("SELECT id FROM competition_editions WHERE slug = $1", [editionSlug])).rows[0];
  if (!ed) throw new Error(`Competition edition "${editionSlug}" does not exist. Create it first.`);

  // Single-line fields get whitespace collapsed; free-text answers are kept verbatim (trimmed only).
  const get = (r: string[], h: string, freeText = false): string | null => {
    const i = idx(h); const cell = i >= 0 ? (r[i] ?? "") : "";
    const v = freeText ? cell.replace(/\r\n/g, "\n").trim() : cell.replace(/\s+/g, " ").trim();
    return v === "" ? null : v;
  };
  const toInt = (v: string | null) => (v !== null && /^\d+$/.test(v) && Number(v) <= 100000 ? Number(v) : null);
  const oneOf = (v: string | null, opts: readonly string[]) => (v !== null && opts.includes(v) ? v : null);

  for (let n = 1; n < rows.length; n++) {
    const r = rows[n]!;
    const school = get(r, HEADERS.school), code = get(r, HEADERS.code);
    if (!school || !code) { report.skipped.push({ line: n + 1, reason: "missing school name or school code" }); continue; }
    const provName = get(r, HEADERS.province), distName = get(r, HEADERS.district), sectName = get(r, HEADERS.sector);
    const tree = locations.tree();
    const probe = provName && distName ? locations.resolve(provName, distName, sectName ?? "") : null;
    let provinceId: string | undefined, districtId: string | undefined, sectorId: string | null = null;
    if (probe?.ok) { provinceId = probe.value.province_id; districtId = probe.value.district_id; sectorId = probe.value.sector_id; }
    else {
      const p = tree.find((x) => provName && normKey(x.name).replace(/cityof|province|city/g, "") === normKey(provName).replace(/cityof|province|city/g, ""));
      const d = p?.districts.find((x) => distName && normKey(x.name) === normKey(distName));
      if (!p || !d) { report.skipped.push({ line: n + 1, reason: "province/district not recognised" }); continue; }
      provinceId = p.id; districtId = d.id; // sector kept as raw text below
    }

    const raw = Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]));
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([ed.id, r])).digest("hex");
    const key = `legacy:${fingerprint}`;
    if ((await db.query("SELECT 1 FROM school_registrations WHERE idempotency_key = $1", [key])).rowCount) { report.alreadyImported++; continue; }
    if (!apply) { report.imported++; continue; }

    const phone = (v: string | null) => (v === null ? null : normalizePhone(v) ?? v);
    const ts = get(r, HEADERS.timestamp); const created = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : null;
    const email = (v: string | null) => (v ? v.toLowerCase() : null);
    await db.transaction(async (tx) => {
      const codeKey = code.toLowerCase();
      const s = (await tx.query<{ id: string }>(
        `INSERT INTO schools (school_code, school_code_normalized, name) VALUES ($1,$2,$3)
         ON CONFLICT (school_code_normalized) DO UPDATE SET updated_at = now() RETURNING id`, [code, codeKey, school])).rows[0]!;
      await tx.query(
        `INSERT INTO school_registrations (
           registration_reference, competition_edition_id, school_id, is_legacy, legacy_raw, idempotency_key, request_fingerprint,
           first_name, email_address, phone_contact, school_role,
           school_name, school_code, school_code_normalized, school_name_normalized, school_type,
           province_id, district_id, sector_id, sector_name_raw, school_bank_name, school_bank_account,
           mathematics_teacher_first_name, mathematics_teacher_email, mathematics_teacher_phone,
           teacher_bank_name, mathematics_teacher_account_number, head_teacher_email, test_delivery_email,
           students_p5_p6, students_s1_s3, students_s4_s5,
           questions_comments_concerns_feedback, additional_information, created_at)
         VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,COALESCE($34::timestamptz, now()))`,
        [`ROF-LEG-${crypto.randomBytes(5).toString("hex").toUpperCase()}`, ed.id, s.id, JSON.stringify(raw), key, fingerprint,
          get(r, HEADERS.name), email(get(r, HEADERS.email)), phone(get(r, HEADERS.phone)), oneOf(get(r, HEADERS.role), SCHOOL_ROLES),
          school, code, codeKey, normKey(school), oneOf(get(r, HEADERS.type), SCHOOL_TYPES),
          provinceId, districtId, sectorId, sectorId ? null : sectName, get(r, HEADERS.bankName), get(r, HEADERS.bankAccount),
          get(r, HEADERS.teacherName), email(get(r, HEADERS.teacherEmail)), phone(get(r, HEADERS.teacherPhone)),
          get(r, HEADERS.teacherBank), get(r, HEADERS.teacherAccount), email(get(r, HEADERS.headEmail)), email(get(r, HEADERS.testEmail)),
          toInt(get(r, HEADERS.p56)), toInt(get(r, HEADERS.s13)), toInt(get(r, HEADERS.s45)),
          get(r, HEADERS.comments, true), get(r, HEADERS.extra, true), created]);
    });
    report.imported++;
  }
  return report;
}
