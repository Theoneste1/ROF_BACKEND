/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { isUniqueViolation } from "./db.js";
import { ApiError, validationError } from "./errors.js";
import { writeAudit, type Actor } from "./audit.js";
import { LocationService, normKey, type ResolvedLocation } from "./locations.js";
import {
  BANK_FIELDS, FIELD_SPECS, LOCATION_FIELDS, REGISTRATION_STATUSES,
  type ValidatedRegistration,
} from "./validation.js";

export const REPLAY_WINDOW_HOURS = 24;
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I

const generateReference = (year: number): string => {
  let s = "";
  for (let i = 0; i < 8; i++) s += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  return `ROF-${year}-${s}`;
};

const codeKey = (code: string): string => code.trim().toLowerCase();

const fingerprintOf = (editionId: string, d: ValidatedRegistration): string =>
  crypto.createHash("sha256").update(JSON.stringify([
    editionId, normKey(d.province), normKey(d.district), normKey(d.sector), d.cell ? normKey(d.cell) : null, d.directory_school_id,
    ...FIELD_SPECS.filter((s) => !LOCATION_FIELDS.includes(s.key as never)).map((s) => d[s.key] ?? null),
  ])).digest("hex");

export interface CreateMeta { idempotencyKey?: string; ip?: string }
export interface CreateResult {
  replayed: boolean;
  registration: {
    id: string; registration_reference: string; status: string; total_estimated_students: number;
    competition_edition: string; created_at: string;
  };
}

const SUMMARY_SQL = `SELECT r.id, r.registration_reference, r.status, r.total_estimated_students, r.created_at,
    r.request_fingerprint, e.name AS edition_name
  FROM school_registrations r JOIN competition_editions e ON e.id = r.competition_edition_id`;

const toResult = (row: Record<string, any>, replayed: boolean): CreateResult => ({
  replayed,
  registration: {
    id: row.id, registration_reference: row.registration_reference, status: row.status,
    total_estimated_students: row.total_estimated_students, competition_edition: row.edition_name,
    created_at: new Date(row.created_at).toISOString(),
  },
});

interface DirectoryEntry { id: string; school_code: string | null; name: string; district_id: string; sector_id: string | null; cell_id: string | null }

/**
 * Applies a directory pick: the school name always comes from the directory and so does the code
 * when the directory has one. If the directory has no code the user must have typed it (manual entry).
 */
async function applyDirectoryChoice(
  db: Queryable, data: ValidatedRegistration, loc: ResolvedLocation,
): Promise<{ data: ValidatedRegistration; cellId: string | null }> {
  if (!data.directory_school_id) {
    return { data, cellId: loc.cell_id };
  }
  const entry = (await db.query<DirectoryEntry>(
    "SELECT id, school_code, name, district_id, sector_id, cell_id FROM school_directory WHERE id = $1 AND is_active", [data.directory_school_id])).rows[0];
  if (!entry) throw validationError({ directory_school_id: "The selected school was not found." });
  // Entries from district-level lists have no sector: they are valid anywhere in their district.
  if (entry.sector_id ? entry.sector_id !== loc.sector_id : entry.district_id !== loc.district_id)
    throw validationError({ directory_school_id: entry.sector_id ? "The selected school is not in the chosen sector." : "The selected school is not in the chosen district." });
  if (loc.cell_id && entry.cell_id && entry.cell_id !== loc.cell_id)
    throw validationError({ directory_school_id: "The selected school is not in the chosen cell." });

  let code = data.school_code;
  if (entry.school_code) {
    if (code && codeKey(code) !== codeKey(entry.school_code))
      throw validationError({ school_code: "School code does not match the selected school." });
    code = entry.school_code;
  } else if (!code) {
    throw validationError({ school_code: "School code is required: the selected school has no code on file, please type it." });
  }
  return { data: { ...data, school_name: entry.name, school_code: code }, cellId: loc.cell_id ?? entry.cell_id };
}

export async function createRegistration(
  db: Db, locations: LocationService, input: ValidatedRegistration, meta: CreateMeta,
): Promise<CreateResult> {
  const loc = locations.resolve(input.province, input.district, input.sector, input.cell);
  if (!loc.ok) throw validationError(loc.errors);
  const { data, cellId } = await applyDirectoryChoice(db, input, loc.value);
  if (!data.school_name || !data.school_code) throw validationError({ school_name: "School name is required.", school_code: "School code is required." });

  const ed = (await db.query<{ id: string; year: number; name: string }>(
    "SELECT id, year, name FROM competition_editions WHERE is_current AND registration_open")).rows[0];
  if (!ed) throw new ApiError(409, "registration_closed", "Registration is not currently open.");

  const fingerprint = fingerprintOf(ed.id, data);
  const actor: Actor = { id: null, label: "public", ip: meta.ip };
  const reused = () => new ApiError(409, "idempotency_key_reused", "This Idempotency-Key was already used with a different registration.");

  const attempt = () => db.transaction(async (tx): Promise<CreateResult> => {
    // Serialise identical concurrent submissions so a double-click cannot create two rows.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fingerprint]);

    if (meta.idempotencyKey) {
      const prior = (await tx.query(`${SUMMARY_SQL} WHERE r.idempotency_key = $1`, [meta.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_fingerprint !== fingerprint) throw reused();
        return toResult(prior, true);
      }
    } else {
      const prior = (await tx.query(
        `${SUMMARY_SQL} WHERE r.request_fingerprint = $1 AND r.created_at > now() - make_interval(hours => $2)
         ORDER BY r.created_at LIMIT 1`, [fingerprint, REPLAY_WINDOW_HOURS])).rows[0];
      if (prior) return toResult(prior, true);
    }

    const school = (await tx.query<{ id: string }>(
      `INSERT INTO schools (school_code, school_code_normalized, name) VALUES ($1, $2, $3)
       ON CONFLICT (school_code_normalized) DO UPDATE SET updated_at = now() RETURNING id`,
      [data.school_code, codeKey(data.school_code), data.school_name])).rows[0]!;

    for (let i = 0; i < 5; i++) {
      const ref = generateReference(ed.year);
      const ins = await tx.query(
        `INSERT INTO school_registrations (
           registration_reference, competition_edition_id, school_id,
           first_name, last_name, email_address, phone_contact, school_role,
           school_name, school_code, school_code_normalized, school_name_normalized, school_type,
           province_id, district_id, sector_id, school_bank_name, school_bank_account,
           head_teacher_first_name, head_teacher_last_name, head_teacher_email, head_teacher_phone,
           mathematics_teacher_first_name, mathematics_teacher_last_name, mathematics_teacher_email, mathematics_teacher_phone,
           test_delivery_email, teacher_bank_name, mathematics_teacher_account_number,
           students_p5_p6, students_s1_s3, students_s4_s5,
           questions_comments_concerns_feedback, additional_information,
           idempotency_key, request_fingerprint, cell_id, directory_school_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
         ON CONFLICT (registration_reference) DO NOTHING
         RETURNING id, registration_reference, status, total_estimated_students, created_at`,
        [ref, ed.id, school.id,
          data.first_name, data.last_name, data.email_address, data.phone_contact, data.school_role,
          data.school_name, data.school_code, codeKey(data.school_code), normKey(data.school_name), data.school_type,
          loc.value.province_id, loc.value.district_id, loc.value.sector_id, data.school_bank_name, data.school_bank_account,
          data.head_teacher_first_name, data.head_teacher_last_name, data.head_teacher_email, data.head_teacher_phone,
          data.mathematics_teacher_first_name, data.mathematics_teacher_last_name, data.mathematics_teacher_email, data.mathematics_teacher_phone,
          data.test_delivery_email, data.teacher_bank_name, data.mathematics_teacher_account_number,
          data.students_p5_p6, data.students_s1_s3, data.students_s4_s5,
          data.questions_comments_concerns_feedback, data.additional_information,
          meta.idempotencyKey ?? null, fingerprint, cellId, data.directory_school_id]);
      const row = ins.rows[0];
      if (!row) continue; // reference collision: try another
      await writeAudit(tx, actor, "registration.created", "school_registration", row.id, { registration_reference: row.registration_reference });
      return toResult({ ...row, edition_name: ed.name }, false);
    }
    throw new ApiError(500, "reference_generation_failed", "Could not generate a registration reference.");
  });

  try {
    return await attempt();
  } catch (err) {
    // Same Idempotency-Key racing in with a different payload fingerprint (different advisory lock).
    if (meta.idempotencyKey && isUniqueViolation(err, "idempotency_key")) {
      const prior = (await db.query(`${SUMMARY_SQL} WHERE r.idempotency_key = $1`, [meta.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_fingerprint !== fingerprint) throw reused();
        return toResult(prior, true);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type BankMode = "none" | "masked" | "full";

const JOINS = `FROM school_registrations r
  JOIN provinces p ON p.id = r.province_id
  JOIN districts d ON d.id = r.district_id
  LEFT JOIN sectors s ON s.id = r.sector_id
  LEFT JOIN cells c ON c.id = r.cell_id
  JOIN competition_editions e ON e.id = r.competition_edition_id`;
const COLUMNS = `r.*, p.name AS province, d.name AS district, COALESCE(s.name, r.sector_name_raw) AS sector, c.name AS cell,
  e.name AS edition_name, e.year AS edition_year`;
const SELECT_SQL = `SELECT ${COLUMNS} ${JOINS}`;

const INTERNAL_COLUMNS = ["legacy_raw", "idempotency_key", "request_fingerprint", "school_code_normalized", "school_name_normalized", "sector_name_raw"];

export const maskAccount = (v: string | null): string | null =>
  v ? `${"*".repeat(Math.max(v.length - 3, 3))}${v.slice(-3)}` : null;

const REQUIRED_COLUMNS = FIELD_SPECS
  .filter((s) => s.required && !LOCATION_FIELDS.includes(s.key as never))
  .map((s) => s.key as string);

export function missingFields(row: Record<string, any>): string[] {
  const missing = REQUIRED_COLUMNS.filter((k) => row[k] === null || row[k] === undefined);
  if (!row.sector) missing.push("sector");
  return missing;
}

export function shapeRegistration(row: Record<string, any>, bank: BankMode): Record<string, any> {
  const out: Record<string, any> = { ...row };
  for (const c of INTERNAL_COLUMNS) delete out[c];
  out.missing_fields = missingFields(row);
  out.is_incomplete = out.missing_fields.length > 0;
  for (const f of BANK_FIELDS) {
    const isAccount = f === "school_bank_account" || f === "mathematics_teacher_account_number";
    if (bank === "none") delete out[f];
    else if (bank === "masked" && isAccount) out[f] = maskAccount(row[f]);
  }
  out.has_bank_details = BANK_FIELDS.some((f) => row[f]);
  return out;
}

const DUP_PREDICATE = (a: string, b: string) => `(
  ${b}.id <> ${a}.id AND ${b}.competition_edition_id = ${a}.competition_edition_id
  AND ${b}.status NOT IN ('rejected','withdrawn')
  AND (${b}.school_code_normalized = ${a}.school_code_normalized
       OR (${b}.school_name_normalized = ${a}.school_name_normalized AND ${b}.district_id = ${a}.district_id)))`;

/** Other registrations in the same edition that share the school code, or the school name within the district. */
export async function findPotentialDuplicates(db: Queryable, id: string) {
  const rows = (await db.query(
    `SELECT o.id, o.registration_reference, o.school_name, o.school_code, o.status, o.created_at,
            (o.school_code_normalized = r.school_code_normalized) AS same_school_code,
            (o.school_name_normalized = r.school_name_normalized AND o.district_id = r.district_id) AS same_name_and_district
     FROM school_registrations r JOIN school_registrations o ON ${DUP_PREDICATE("r", "o")}
     WHERE r.id = $1 ORDER BY o.created_at`, [id])).rows;
  return rows.map((o) => ({
    id: o.id, registration_reference: o.registration_reference, school_name: o.school_name,
    school_code: o.school_code, status: o.status, created_at: o.created_at,
    reasons: [o.same_school_code && "same_school_code", o.same_name_and_district && "same_school_name_and_district"].filter(Boolean),
  }));
}

export async function getRegistration(db: Queryable, id: string) {
  if (!UUID_RE.test(id)) throw new ApiError(404, "not_found", "Registration not found.");
  const row = (await db.query(`${SELECT_SQL} WHERE r.id = $1`, [id])).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Registration not found.");
  return row;
}

export interface ListQuery {
  page: number; pageSize: number; q?: string; editionId?: string; province?: string; district?: string; sector?: string; cell?: string;
  schoolType?: string; status?: string; incomplete?: boolean; potentialDuplicates?: boolean; inDirectory?: boolean;
  createdFrom?: string; createdTo?: string; sort: string; order: "asc" | "desc";
}

const SORTS: Record<string, string> = {
  created_at: "r.created_at", school_name: "lower(r.school_name)", total_estimated_students: "r.total_estimated_students",
  status: "r.status", registration_reference: "r.registration_reference",
};
export const SORT_KEYS = Object.keys(SORTS);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const SEARCH_COLUMNS = [
  "r.school_name", "r.school_code", "r.registration_reference", "r.email_address", "r.head_teacher_email",
  "r.mathematics_teacher_email", "r.test_delivery_email",
  "(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,''))",
  "(COALESCE(r.mathematics_teacher_first_name,'') || ' ' || COALESCE(r.mathematics_teacher_last_name,''))",
  "(COALESCE(r.head_teacher_first_name,'') || ' ' || COALESCE(r.head_teacher_last_name,''))",
];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildWhere(q: Partial<ListQuery>): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.editionId) conds.push(`r.competition_edition_id = ${add(q.editionId)}`);
  if (q.status) conds.push(`r.status = ${add(q.status)}`);
  if (q.schoolType) conds.push(`r.school_type = ${add(q.schoolType)}`);
  const locs: [string | undefined, string, string][] = [
    [q.province, "r.province_id", "p.name"], [q.district, "r.district_id", "d.name"], [q.sector, "r.sector_id", "s.name"], [q.cell, "r.cell_id", "c.name"],
  ];
  for (const [val, idCol, nameCol] of locs) {
    if (!val) continue;
    conds.push(UUID_RE.test(val) ? `${idCol} = ${add(val)}` : `lower(${nameCol}) = ${add(val.trim().toLowerCase())}`);
  }
  if (q.inDirectory !== undefined) conds.push(q.inDirectory ? "r.directory_school_id IS NOT NULL" : "r.directory_school_id IS NULL");
  if (q.createdFrom) conds.push(`r.created_at >= ${add(q.createdFrom)}`);
  if (q.createdTo) conds.push(`r.created_at < ${add(q.createdTo)}`);
  if (q.incomplete === true) conds.push(`(${[...REQUIRED_COLUMNS.map((c) => `r.${c} IS NULL`), "r.sector_id IS NULL"].join(" OR ")})`);
  if (q.potentialDuplicates === true) conds.push(`EXISTS (SELECT 1 FROM school_registrations o WHERE ${DUP_PREDICATE("r", "o")})`);
  if (q.q) {
    for (const token of q.q.trim().split(/\s+/).slice(0, 5)) {
      const p = add(`%${escapeLike(token)}%`);
      conds.push(`(${SEARCH_COLUMNS.map((c) => `${c} ILIKE ${p}`).join(" OR ")})`);
    }
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export async function listRegistrations(db: Queryable, q: ListQuery, bank: BankMode) {
  const { where, params } = buildWhere(q);
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n ${JOINS} ${where}`, params)).rows[0]!.n);
  const sortCol = SORTS[q.sort] ?? SORTS.created_at!;
  const rows = (await db.query(
    `SELECT ${COLUMNS},
       EXISTS (SELECT 1 FROM school_registrations o WHERE ${DUP_PREDICATE("r", "o")}) AS has_potential_duplicates
     ${JOINS} ${where} ORDER BY ${sortCol} ${q.order === "asc" ? "ASC" : "DESC"}, r.id
     LIMIT ${Math.trunc(q.pageSize)} OFFSET ${Math.trunc((q.page - 1) * q.pageSize)}`, params)).rows;
  return {
    data: rows.map((r) => ({ ...shapeRegistration(r, bank), has_potential_duplicates: r.has_potential_duplicates })),
    pagination: { page: q.page, page_size: q.pageSize, total, total_pages: Math.max(1, Math.ceil(total / q.pageSize)) },
  };
}

export const EXPORT_LIMIT = 50000;

export async function exportRows(db: Queryable, q: Partial<ListQuery>): Promise<Record<string, any>[]> {
  const { where, params } = buildWhere(q);
  return (await db.query(
    `SELECT ${COLUMNS} ${JOINS} ${where} ORDER BY r.created_at, r.id LIMIT ${EXPORT_LIMIT}`, params)).rows;
}

export async function statistics(db: Queryable, editionId?: string) {
  const w = editionId ? "WHERE r.competition_edition_id = $1" : "";
  const params = editionId ? [editionId] : [];
  const active = "r.status NOT IN ('rejected','withdrawn')";
  const incomplete = `(${[...REQUIRED_COLUMNS.map((c) => `r.${c} IS NULL`), "r.sector_id IS NULL"].join(" OR ")})`;
  const totals = (await db.query(
    `SELECT count(*)::int AS registrations,
       count(*) FILTER (WHERE ${active})::int AS active_registrations,
       count(DISTINCT r.school_id) FILTER (WHERE ${active})::int AS distinct_schools,
       COALESCE(sum(r.students_p5_p6) FILTER (WHERE ${active}), 0)::int AS students_p5_p6,
       COALESCE(sum(r.students_s1_s3) FILTER (WHERE ${active}), 0)::int AS students_s1_s3,
       COALESCE(sum(r.students_s4_s5) FILTER (WHERE ${active}), 0)::int AS students_s4_s5,
       COALESCE(sum(r.total_estimated_students) FILTER (WHERE ${active}), 0)::int AS total_estimated_students,
       count(*) FILTER (WHERE ${incomplete})::int AS incomplete_registrations,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM school_registrations o WHERE ${DUP_PREDICATE("r", "o")}))::int AS potential_duplicate_registrations
     FROM school_registrations r ${w}`, params)).rows[0]!;
  const group = async (expr: string, join: string) => (await db.query(
    `SELECT ${expr} AS key, count(*)::int AS registrations,
            COALESCE(sum(r.total_estimated_students), 0)::int AS total_estimated_students
     FROM school_registrations r ${join} ${w ? w + " AND" : "WHERE"} ${active} GROUP BY 1 ORDER BY 2 DESC, 1`, params)).rows;
  return {
    note: "Student totals and breakdowns exclude rejected and withdrawn registrations.",
    totals,
    by_status: (await db.query(
      `SELECT r.status AS key, count(*)::int AS registrations FROM school_registrations r ${w} GROUP BY 1 ORDER BY 2 DESC, 1`, params)).rows,
    by_province: await group("p.name", "JOIN provinces p ON p.id = r.province_id"),
    by_district: await group("d.name", "JOIN districts d ON d.id = r.district_id"),
    by_school_type: await group("COALESCE(r.school_type, 'Unknown')", ""),
  };
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

const COLUMN_FIELDS = FIELD_SPECS.map((s) => s.key as string).filter((k) => !LOCATION_FIELDS.includes(k as never));

export async function updateRegistration(
  db: Db, locations: LocationService, id: string, patch: Partial<ValidatedRegistration>, actor: Actor,
) {
  if (!UUID_RE.test(id)) throw new ApiError(404, "not_found", "Registration not found.");
  return db.transaction(async (tx) => {
    const cur = (await tx.query(`${SELECT_SQL} WHERE r.id = $1 FOR UPDATE OF r`, [id])).rows[0];
    if (!cur) throw new ApiError(404, "not_found", "Registration not found.");

    const sets: Record<string, unknown> = {};
    const p = patch as Record<string, unknown>;
    for (const k of COLUMN_FIELDS) if (k in p) sets[k] = p[k];

    if (LOCATION_FIELDS.some((f) => f in p)) {
      // A cell only belongs to its own sector, so moving the sector clears the old cell unless a new one is given.
      const movesAbove = ["province", "district", "sector"].some((f) => f in p);
      const cell = "cell" in p ? (p.cell as string | null) : movesAbove ? null : cur.cell;
      const loc = locations.resolve(
        (p.province as string) ?? cur.province, (p.district as string) ?? cur.district, (p.sector as string) ?? cur.sector ?? "", cell);
      if (!loc.ok) throw validationError(loc.errors);
      sets.province_id = loc.value.province_id;
      sets.district_id = loc.value.district_id;
      sets.sector_id = loc.value.sector_id;
      sets.cell_id = loc.value.cell_id;
      sets.sector_name_raw = null;
    }
    if ("school_name" in sets) sets.school_name_normalized = normKey(String(sets.school_name));
    if ("school_code" in sets) {
      const code = String(sets.school_code);
      sets.school_code_normalized = codeKey(code);
      sets.school_id = (await tx.query<{ id: string }>(
        `INSERT INTO schools (school_code, school_code_normalized, name) VALUES ($1,$2,$3)
         ON CONFLICT (school_code_normalized) DO UPDATE SET updated_at = now() RETURNING id`,
        [code, sets.school_code_normalized, sets.school_name ?? cur.school_name])).rows[0]!.id;
    }

    // Audit diff of fields that really change. Bank values are never copied into the audit log.
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      const before = (cur as Record<string, unknown>)[k];
      if (before === v || (before == null && v == null)) { delete sets[k]; continue; }
      changes[k] = (BANK_FIELDS as readonly string[]).includes(k) ? "changed" : { from: before ?? null, to: v };
    }
    if (Object.keys(changes).length === 0) return getRegistration(tx, id);

    const cols = Object.keys(sets);
    await tx.query(
      `UPDATE school_registrations SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`,
      [id, ...cols.map((c) => sets[c])]);
    await writeAudit(tx, actor, "registration.updated", "school_registration", id, changes);
    return getRegistration(tx, id);
  });
}

export async function changeStatus(db: Db, id: string, status: string, note: string | null, actor: Actor) {
  if (!(REGISTRATION_STATUSES as readonly string[]).includes(status))
    throw validationError({ status: `Status must be one of: ${REGISTRATION_STATUSES.join(", ")}.` });
  if (note && note.length > 1000) throw validationError({ note: "Note must be at most 1000 characters." });
  if ((status === "rejected" || status === "withdrawn") && !note?.trim())
    throw validationError({ note: `A note is required when setting status to ${status}.` });
  if (!UUID_RE.test(id)) throw new ApiError(404, "not_found", "Registration not found.");
  return db.transaction(async (tx) => {
    const cur = (await tx.query<{ status: string }>("SELECT status FROM school_registrations WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw new ApiError(404, "not_found", "Registration not found.");
    if (cur.status === status) throw new ApiError(409, "status_unchanged", `Registration is already ${status}.`);
    await tx.query("UPDATE school_registrations SET status=$2, status_note=$3 WHERE id=$1", [id, status, note?.trim() || null]);
    await writeAudit(tx, actor, "registration.status_changed", "school_registration", id, { from: cur.status, to: status, note: note?.trim() || null });
    return getRegistration(tx, id);
  });
}

// ---------------------------------------------------------------------------
// School directory (public pick-list for the registration form)
// ---------------------------------------------------------------------------

export interface DirectorySchool { id: string; name: string; school_code: string | null; school_type: string | null; sector_id: string | null; cell_id: string | null }

/**
 * Active directory schools for a sector: those recorded in that sector, plus those only known at district level.
 * Optionally narrowed to a cell (schools with no cell on file are kept) and/or a name search.
 */
export async function searchDirectorySchools(db: Queryable, o: { sectorId: string; cellId?: string; q?: string }): Promise<DirectorySchool[]> {
  const params: unknown[] = [o.sectorId];
  let where = "is_active AND district_id = (SELECT district_id FROM sectors WHERE id = $1) AND (sector_id = $1 OR sector_id IS NULL)";
  if (o.cellId) { params.push(o.cellId); where += ` AND (cell_id = $${params.length} OR cell_id IS NULL)`; }
  if (o.q) { params.push(`%${escapeLike(o.q)}%`); where += ` AND name ILIKE $${params.length}`; }
  return (await db.query<DirectorySchool>(
    `SELECT id, name, school_code, school_type, sector_id, cell_id FROM school_directory WHERE ${where}
     ORDER BY (sector_id IS NULL), lower(name) LIMIT 500`, params)).rows;
}

// ---------------------------------------------------------------------------
// Public list of registered schools (no personal data)
// ---------------------------------------------------------------------------

export interface PublicRegisteredSchool { school_code: string; school_name: string; district: string; student_count: number }

/**
 * One row per school for an edition: school code, name, district and the estimated student count from the school's most
 * recent registration. Rejected and withdrawn registrations are excluded. Nothing else leaves the database, so this is
 * safe to serve without authentication.
 */
export async function listPublicRegisteredSchools(db: Queryable, editionId: string) {
  const rows = (await db.query<PublicRegisteredSchool>(
    `SELECT school_code, school_name, district, student_count FROM (
       SELECT DISTINCT ON (r.school_id) r.school_code, r.school_name, d.name AS district,
              r.total_estimated_students AS student_count, r.created_at
       FROM school_registrations r JOIN districts d ON d.id = r.district_id
       WHERE r.competition_edition_id = $1 AND r.status NOT IN ('rejected','withdrawn')
       ORDER BY r.school_id, r.created_at DESC
     ) latest ORDER BY lower(school_name), school_code`, [editionId])).rows;
  return {
    total_schools: rows.length,
    total_students: rows.reduce((sum, r) => sum + r.student_count, 0),
    schools: rows,
  };
}
