/* eslint-disable @typescript-eslint/no-explicit-any */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import { ApiError, validationError } from "./errors.js";
import { LocationService } from "./locations.js";
import { writeAudit, type Actor } from "./audit.js";
import {
  can, getDummyHash, signToken, verifyPassword, verifyToken, type Permission, type Role,
} from "./auth.js";
import {
  REGISTRATION_STATUSES, SCHOOL_TYPES, validateRegistration, validateRegistrationPatch, BANK_FIELDS,
} from "./validation.js";
import {
  SORT_KEYS, UUID_RE, changeStatus, createRegistration, exportRows, findPotentialDuplicates, getRegistration,
  listPublicRegisteredSchools, listRegistrations, searchDirectorySchools, shapeRegistration, statistics, updateRegistration, type BankMode, type ListQuery,
} from "./registrations.js";
import { toCsv, type CsvColumn } from "./csv.js";

export interface AppDeps { db: Db; config: Config; logger?: boolean }

interface AdminCtx { id: string; email: string; role: Role }
declare module "fastify" {
  interface FastifyRequest { admin?: AdminCtx }
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export async function buildApp({ db, config, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy,
    logger: logger
      ? {
          level: "info",
          redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" },
          // Log the path only: query strings can carry search terms such as names or emails.
          serializers: {
            req: (req: FastifyRequest) => ({ method: req.method, url: req.url.split("?")[0], remoteAddress: req.ip }),
          },
        }
      : false,
  });

  const locations = new LocationService(db);
  await locations.load();

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposedHeaders: ["Content-Disposition", "Idempotent-Replayed"],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: false });

  // Only JSON bodies are accepted on write endpoints.
  app.addHook("preValidation", async (req) => {
    if ((req.method === "POST" || req.method === "PATCH") && req.body !== undefined && !/^application\/json/i.test(req.headers["content-type"] ?? ""))
      throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  });

  app.addHook("onSend", async (req, reply) => {
    if (!req.url.startsWith("/api/locations") && !req.url.startsWith("/api/competition-editions") && !req.url.startsWith("/api/registered-schools")) {
      reply.header("Cache-Control", "no-store");
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests. Please try again later." } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      const map: Record<number, string> = { 400: "bad_request", 413: "payload_too_large", 415: "unsupported_media_type" };
      return reply.status(err.statusCode).send({ error: { code: map[err.statusCode] ?? "bad_request", message: err.statusCode === 400 ? "Malformed request." : err.message } });
    }
    req.log.error({ err: { message: err.message, code: err.code } }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Route not found." } }));

  // ----- auth helpers -----
  const authenticate = async (req: FastifyRequest): Promise<AdminCtx> => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const claims = token ? await verifyToken(config.jwtSecret, token) : null;
    if (!claims) throw new ApiError(401, "unauthorized", "Authentication required.");
    const user = (await db.query<{ id: string; email: string; role: Role; is_active: boolean; token_version: number }>(
      "SELECT id, email, role, is_active, token_version FROM admin_users WHERE id = $1", [claims.sub])).rows[0];
    if (!user || !user.is_active || user.token_version !== claims.tv) throw new ApiError(401, "unauthorized", "Authentication required.");
    return { id: user.id, email: user.email, role: user.role };
  };
  const guard = (perm: Permission) => async (req: FastifyRequest) => {
    const admin = await authenticate(req);
    if (!can(admin.role, perm)) throw new ApiError(403, "forbidden", "You do not have permission to perform this action.");
    req.admin = admin;
  };
  const actorOf = (req: FastifyRequest): Actor => ({ id: req.admin?.id ?? null, label: req.admin?.email ?? "public", ip: req.ip });
  const bankMode = (role: Role): BankMode => (can(role, "bank:read") ? "masked" : "none");

  // ----- health & public reference data -----
  app.get("/health", async (_req, reply) => {
    try { await db.query("SELECT 1"); return { status: "ok" }; }
    catch { return reply.status(503).send({ status: "unavailable" }); }
  });

  app.get("/api/locations", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return { provinces: locations.tree() };
  });

  // Cascade step after sector: the cells of one sector.
  app.get("/api/locations/sectors/:sectorId/cells", async (req, reply) => {
    const { sectorId } = req.params as { sectorId: string };
    const cells = UUID_RE.test(sectorId) ? locations.cellsOf(sectorId) : null;
    if (!cells) throw new ApiError(404, "not_found", "Sector not found.");
    reply.header("Cache-Control", "public, max-age=3600");
    return { cells };
  });

  // Final cascade step: schools known for the chosen sector (and cell). Picking one pre-fills name and code;
  // when the school is missing, or has no code on file, the form falls back to manual entry.
  app.get("/api/schools", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const sectorId = typeof q.sector_id === "string" ? q.sector_id : "";
    const cellId = typeof q.cell_id === "string" && q.cell_id !== "" ? q.cell_id : undefined;
    const search = typeof q.q === "string" && q.q.trim() !== "" ? q.q.trim().slice(0, 100) : undefined;
    const errors: Record<string, string> = {};
    if (!UUID_RE.test(sectorId)) errors.sector_id = "sector_id is required.";
    if (cellId && !UUID_RE.test(cellId)) errors.cell_id = "cell_id must be a UUID.";
    if (Object.keys(errors).length) throw validationError(errors);
    return { schools: await searchDirectorySchools(db, { sectorId, cellId, q: search }), manual_entry_allowed: true };
  });

  // Public list for the "Registered Schools" page: school code, name, district, student count. No personal data.
  app.get("/api/registered-schools", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const raw = (req.query as Record<string, unknown>).edition_id;
    if (raw !== undefined && !(typeof raw === "string" && UUID_RE.test(raw))) throw validationError({ edition_id: "edition_id must be a UUID." });
    const edition = (await db.query<{ id: string; name: string; year: number }>(
      raw ? "SELECT id, name, year FROM competition_editions WHERE id = $1" : "SELECT id, name, year FROM competition_editions WHERE is_current",
      raw ? [raw] : [])).rows[0];
    reply.header("Cache-Control", "public, max-age=60");
    if (!edition) return { edition: null, total_schools: 0, total_students: 0, schools: [] };
    return { edition: { name: edition.name, year: edition.year }, ...(await listPublicRegisteredSchools(db, edition.id)) };
  });

  app.get("/api/competition-editions/current", async (_req, reply) => {
    const ed = (await db.query("SELECT id, name, year, registration_open FROM competition_editions WHERE is_current")).rows[0];
    if (!ed) return reply.status(404).send({ error: { code: "no_current_edition", message: "No competition edition is currently configured." } });
    reply.header("Cache-Control", "public, max-age=60");
    return ed;
  });

  // ----- authentication -----
  app.post("/api/auth/login", { config: { rateLimit: { max: config.loginRateLimitMax, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password || password.length > 256) throw validationError({ email: "Email and password are required." });

    const user = (await db.query<any>("SELECT * FROM admin_users WHERE email = $1", [email])).rows[0];
    const invalid = new ApiError(401, "invalid_credentials", "Invalid email or password.");
    // Always run a hash comparison so timing doesn't reveal whether the email exists.
    const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !user.is_active) throw invalid;
    if (user.locked_until && new Date(user.locked_until) > new Date())
      throw new ApiError(429, "account_locked", "Too many failed attempts. Try again later.");
    if (!ok) {
      const lock = user.failed_attempts + 1 >= MAX_FAILED_LOGINS;
      await db.query(
        `UPDATE admin_users SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
        [user.id, lock ? 0 : user.failed_attempts + 1, lock, LOCK_MINUTES]);
      await writeAudit(db, { id: user.id, label: user.email, ip: req.ip }, lock ? "auth.account_locked" : "auth.login_failed", "admin_user", user.id);
      throw invalid;
    }
    await db.query("UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);
    await writeAudit(db, { id: user.id, label: user.email, ip: req.ip }, "auth.login", "admin_user", user.id);
    const token = await signToken(config.jwtSecret, { sub: user.id, role: user.role, tv: user.token_version }, config.jwtTtlSeconds);
    return reply.send({ token, token_type: "Bearer", expires_in: config.jwtTtlSeconds, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  });

  app.get("/api/auth/me", async (req) => {
    const admin = await authenticate(req);
    return { id: admin.id, email: admin.email, role: admin.role };
  });

  // ----- public registration -----
  app.post("/api/school-registrations", {
    config: { rateLimit: { max: config.publicRateLimitMax, timeWindow: config.publicRateLimitWindowMs } },
  }, async (req, reply) => {
    const body = req.body;
    // Honeypot: real users never see this field; bots that fill every input do. Pretend success, store nothing.
    if (body && typeof body === "object" && typeof (body as any).website === "string" && (body as any).website.trim() !== "") {
      return reply.status(202).send({ status: "received" });
    }
    const keyHeader = req.headers["idempotency-key"];
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key))
      throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-128 characters of letters, digits, '_', '.', ':' or '-'.");

    const parsed = validateRegistration(body);
    if (!parsed.ok) throw validationError(parsed.errors);

    const result = await createRegistration(db, locations, parsed.data, { idempotencyKey: key, ip: req.ip });
    reply.header("Idempotent-Replayed", String(result.replayed));
    return reply.status(result.replayed ? 200 : 201).send({
      message: result.replayed ? "This registration was already received." : "Registration submitted successfully.",
      replayed: result.replayed,
      registration: result.registration,
    });
  });

  // ----- admin: list / export / statistics (static routes are matched before :id) -----
  const parseListQuery = (raw: Record<string, any>): ListQuery => {
    const errors: Record<string, string> = {};
    const str = (k: string) => (typeof raw[k] === "string" && raw[k].trim() !== "" ? raw[k].trim() : undefined);
    const int = (k: string, def: number, min: number, max: number) => {
      const v = str(k); if (v === undefined) return def;
      if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) { errors[k] = `${k} must be an integer between ${min} and ${max}.`; return def; }
      return Number(v);
    };
    const bool = (k: string) => { const v = str(k); if (v === undefined) return undefined; if (v !== "true" && v !== "false") { errors[k] = `${k} must be true or false.`; return undefined; } return v === "true"; };
    const oneOf = (k: string, opts: readonly string[]) => { const v = str(k); if (v !== undefined && !opts.includes(v)) errors[k] = `${k} must be one of: ${opts.join(", ")}.`; return v; };
    const date = (k: string) => { const v = str(k); if (v !== undefined && (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v)))) errors[k] = `${k} must be an ISO date.`; return v; };
    const editionId = str("edition_id");
    if (editionId && !UUID_RE.test(editionId)) errors.edition_id = "edition_id must be a UUID.";
    const q: ListQuery = {
      page: int("page", 1, 1, 1_000_000), pageSize: int("page_size", 25, 1, 100),
      q: str("q")?.slice(0, 100), editionId, province: str("province"), district: str("district"), sector: str("sector"), cell: str("cell"),
      schoolType: oneOf("school_type", SCHOOL_TYPES), status: oneOf("status", REGISTRATION_STATUSES),
      incomplete: bool("incomplete"), potentialDuplicates: bool("potential_duplicates"), inDirectory: bool("in_directory"),
      createdFrom: date("created_from"), createdTo: date("created_to"),
      sort: oneOf("sort", SORT_KEYS) ?? "created_at", order: (oneOf("order", ["asc", "desc"]) as "asc" | "desc") ?? "desc",
    };
    // Accept the form's labels ("Southern") as well as official names and ids.
    if (q.province && !UUID_RE.test(q.province)) {
      const pid = locations.provinceId(q.province);
      if (pid) q.province = pid; else errors.province = `"${q.province}" is not a province of Rwanda.`;
    }
    if (Object.keys(errors).length) throw validationError(errors);
    return q;
  };

  app.get("/api/school-registrations", { preHandler: guard("registrations:read") }, async (req) => {
    return listRegistrations(db, parseListQuery(req.query as any), bankMode(req.admin!.role));
  });

  app.get("/api/school-registrations/statistics", { preHandler: guard("registrations:stats") }, async (req) => {
    const raw = (req.query as any).edition_id as string | undefined;
    let editionId = raw;
    if (raw === "all") editionId = undefined;
    else if (!raw) editionId = (await db.query<{ id: string }>("SELECT id FROM competition_editions WHERE is_current")).rows[0]?.id;
    else if (!UUID_RE.test(raw)) throw validationError({ edition_id: "edition_id must be a UUID or 'all'." });
    return statistics(db, editionId);
  });

  const BASE_COLUMNS: CsvColumn[] = [
    { header: "Registration Reference", value: (r) => r.registration_reference },
    { header: "Competition Edition", value: (r) => r.edition_name },
    { header: "Status", value: (r) => r.status },
    { header: "Submitted At", value: (r) => r.created_at },
    { header: "First Name", value: (r) => r.first_name },
    { header: "Last Name", value: (r) => r.last_name },
    { header: "Email Address", value: (r) => r.email_address },
    { header: "Phone Contact", value: (r) => r.phone_contact, text: true },
    { header: "Role at School", value: (r) => r.school_role },
    { header: "School Name", value: (r) => r.school_name },
    { header: "School Code", value: (r) => r.school_code, text: true },
    { header: "School Type", value: (r) => r.school_type },
    { header: "Province", value: (r) => r.province },
    { header: "District", value: (r) => r.district },
    { header: "Sector", value: (r) => r.sector },
    { header: "Cell", value: (r) => r.cell },
    { header: "Headteacher First Name", value: (r) => r.head_teacher_first_name },
    { header: "Headteacher Last Name", value: (r) => r.head_teacher_last_name },
    { header: "Headteacher Email", value: (r) => r.head_teacher_email },
    { header: "Headteacher Phone", value: (r) => r.head_teacher_phone, text: true },
    { header: "Mathematics Teacher First Name", value: (r) => r.mathematics_teacher_first_name },
    { header: "Mathematics Teacher Last Name", value: (r) => r.mathematics_teacher_last_name },
    { header: "Mathematics Teacher Email", value: (r) => r.mathematics_teacher_email },
    { header: "Mathematics Teacher Phone", value: (r) => r.mathematics_teacher_phone, text: true },
    { header: "Email To Send The Test To", value: (r) => r.test_delivery_email },
    { header: "Students P5-P6", value: (r) => r.students_p5_p6 },
    { header: "Students S1-S3", value: (r) => r.students_s1_s3 },
    { header: "Students S4-S5", value: (r) => r.students_s4_s5 },
    { header: "Total Estimated Students", value: (r) => r.total_estimated_students },
    { header: "Questions/Comments/Concerns/Feedback", value: (r) => r.questions_comments_concerns_feedback },
    { header: "Additional Information", value: (r) => r.additional_information },
  ];
  const BANK_COLUMNS: CsvColumn[] = [
    { header: "School Bank Name", value: (r) => r.school_bank_name },
    { header: "School Bank Account", value: (r) => r.school_bank_account, text: true },
    { header: "Teacher's Bank Name", value: (r) => r.teacher_bank_name },
    { header: "Mathematics Teacher's Account Number", value: (r) => r.mathematics_teacher_account_number, text: true },
  ];

  app.get("/api/school-registrations/export", { preHandler: guard("registrations:export") }, async (req, reply) => {
    const raw = req.query as Record<string, any>;
    const includeBank = raw.include_bank === "true";
    if (includeBank && !can(req.admin!.role, "bank:read"))
      throw new ApiError(403, "forbidden", "You do not have permission to export bank details.");
    const excelSafe = raw.excel_safe !== "false";
    const q = parseListQuery(raw);
    const rows = await exportRows(db, q);
    await writeAudit(db, actorOf(req), "registration.exported", "school_registration", null, {
      rows: rows.length, include_bank: includeBank, excel_safe: excelSafe,
      filters: Object.fromEntries(Object.entries(q).filter(([k, v]) => v !== undefined && !["page", "pageSize", "sort", "order"].includes(k))),
    });
    const csv = toCsv(includeBank ? [...BASE_COLUMNS, ...BANK_COLUMNS] : BASE_COLUMNS, rows, excelSafe);
    return reply.header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="school-registrations-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });

  // ----- admin: single registration -----
  app.get("/api/school-registrations/:id", { preHandler: guard("registrations:read") }, async (req) => {
    const { id } = req.params as { id: string };
    const reveal = (req.query as any).reveal_bank === "true";
    const role = req.admin!.role;
    if (reveal && !can(role, "bank:read")) throw new ApiError(403, "forbidden", "You do not have permission to view bank details.");
    const row = await getRegistration(db, id);
    if (reveal) await writeAudit(db, actorOf(req), "registration.bank_details_viewed", "school_registration", id);
    const history = (await db.query(
      `SELECT r.id, r.registration_reference, r.status, r.created_at, e.name AS edition_name
       FROM school_registrations r JOIN competition_editions e ON e.id = r.competition_edition_id
       WHERE r.school_id = $1 AND r.id <> $2 ORDER BY r.created_at DESC`, [row.school_id, id])).rows;
    return {
      ...shapeRegistration(row, reveal ? "full" : bankMode(role)),
      potential_duplicates: await findPotentialDuplicates(db, id),
      school_registration_history: history,
    };
  });

  app.get("/api/school-registrations/:id/audit", { preHandler: guard("audit:read") }, async (req) => {
    const { id } = req.params as { id: string };
    await getRegistration(db, id);
    const rows = (await db.query(
      "SELECT id, actor_label, action, changes, created_at FROM audit_log WHERE entity_type = 'school_registration' AND entity_id = $1 ORDER BY id DESC LIMIT 200", [id])).rows;
    return { data: rows };
  });

  // Either permission lets a caller in; each field group then requires its own:
  // bank details need bank:write (finance, super_admin), everything else needs registrations:update.
  const guardPatch = async (req: FastifyRequest) => {
    const admin = await authenticate(req);
    if (!can(admin.role, "registrations:update") && !can(admin.role, "bank:write"))
      throw new ApiError(403, "forbidden", "You do not have permission to perform this action.");
    req.admin = admin;
  };
  app.patch("/api/school-registrations/:id", { preHandler: guardPatch }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = validateRegistrationPatch(req.body);
    if (!parsed.ok) throw validationError(parsed.errors);
    const role = req.admin!.role;
    const touchesBank = BANK_FIELDS.some((f) => f in parsed.data);
    const touchesOther = Object.keys(parsed.data).some((k) => !(BANK_FIELDS as readonly string[]).includes(k));
    if (touchesBank && !can(role, "bank:write"))
      throw new ApiError(403, "forbidden", "You do not have permission to change bank details.");
    if (touchesOther && !can(role, "registrations:update"))
      throw new ApiError(403, "forbidden", "You do not have permission to change registration details.");
    const row = await updateRegistration(db, locations, id, parsed.data, actorOf(req));
    return shapeRegistration(row, bankMode(req.admin!.role));
  });

  app.patch("/api/school-registrations/:id/status", { preHandler: guard("registrations:status") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.status !== "string") throw validationError({ status: "Status is required." });
    const note = body.note === undefined || body.note === null ? null : typeof body.note === "string" ? body.note : (() => { throw validationError({ note: "Note must be text." }); })();
    const row = await changeStatus(db, id, body.status, note, actorOf(req));
    return shapeRegistration(row, bankMode(req.admin!.role));
  });

  return app;
}

export type { FastifyReply };
