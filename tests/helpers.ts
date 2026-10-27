/* eslint-disable @typescript-eslint/no-explicit-any */
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import type { Db, Queryable } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { runMigrations } from "../src/migrate.js";
import { seedLocations } from "../src/locations.js";
import { hashPassword, type Role } from "../src/auth.js";

export function pgliteDb(pg = new PGlite()): Db & { raw: PGlite } {
  const q = (target: { query: PGlite["query"] }) => async (text: string, params?: unknown[]) => {
    const r = await target.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  };
  return {
    raw: pg,
    query: q(pg) as any,
    exec: async (sql) => { await pg.exec(sql); },
    transaction: (fn) => pg.transaction((t) => fn({ query: q(t as any) as any, exec: async (sql: string) => { await t.exec(sql); } } as Queryable)),
    close: () => pg.close(),
  };
}

export const testConfig = (over: Partial<Config> = {}): Config => ({
  nodeEnv: "test", port: 0, host: "127.0.0.1", databaseUrl: "unused", databaseSsl: false, databaseSslRejectUnauthorized: true,
  jwtSecret: "test-secret-test-secret-test-secret-123456", jwtTtlSeconds: 3600,
  corsOrigins: ["https://rwandamathcompetition.netlify.app"], corsOriginPatterns: ["https://*--rwandamathcompetition.netlify.app"], corsAllowLocalhost: true, trustProxy: false,
  publicRateLimitMax: 1000, publicRateLimitWindowMs: 60_000, loginRateLimitMax: 1000, ...over,
});

let template: Promise<Blob | File> | undefined;
/** A migrated + seeded database (fresh per call, cloned from a one-time template for speed). */
export async function freshDb() {
  template ??= (async () => {
    const seed = pgliteDb();
    await runMigrations(seed);
    await seedLocations(seed);
    const dump = await seed.raw.dumpDataDir("none");
    await seed.close();
    return dump;
  })();
  return pgliteDb(new PGlite({ loadDataDir: await template }));
}

export async function createEdition(db: Db, o: { year?: number; slug?: string; open?: boolean; current?: boolean; name?: string } = {}) {
  const year = o.year ?? 2026;
  const r = await db.query<{ id: string }>(
    "INSERT INTO competition_editions (year, name, slug, registration_open, is_current) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [year, o.name ?? `Test Olympiad ${year}`, o.slug ?? String(year), o.open ?? true, o.current ?? true]);
  return r.rows[0]!.id;
}

export const PASSWORD = "correct horse battery staple";
export async function createAdmin(db: Db, role: Role, email = `${role}@test.example`) {
  await db.query("INSERT INTO admin_users (email, full_name, password_hash, role) VALUES ($1,$2,$3,$4)",
    [email, `Test ${role}`, await hashPassword(PASSWORD), role]);
  return email;
}

export async function loginAs(app: FastifyInstance, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return res.json().token;
}

/** Valid synthetic payload; override anything per test. All data is fake. */
export function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    first_name: "Aline", last_name: "Uwase", email_address: "Aline.Uwase@example.org", phone_contact: "0788123456",
    school_role: "Teacher",
    school_name: "Groupe Scolaire Test", school_code: "012345", school_type: "Public",
    province: "Kigali", district: "Gasabo", sector: "Kinyinya",
    school_bank_name: "Test Bank", school_bank_account: "0001234567890",
    head_teacher_first_name: "Jean", head_teacher_last_name: "Mugabo",
    head_teacher_email: "head@example.org", head_teacher_phone: "0722000111",
    mathematics_teacher_first_name: "Claire", mathematics_teacher_last_name: "Ingabire",
    mathematics_teacher_email: "claire@example.org", mathematics_teacher_phone: "0733000222",
    test_delivery_email: "tests@example.org",
    teacher_bank_name: "Other Bank", mathematics_teacher_account_number: "00098765432",
    students_p5_p6: 10, students_s1_s3: "20", students_s4_s5: 0,
    questions_comments_concerns_feedback: "Is there a fee?", additional_information: "We have a computer lab.",
    ...over,
  };
}

export async function makeApp(over: Partial<Config> = {}) {
  const db = await freshDb();
  const editionId = await createEdition(db);
  const app = await buildApp({ db, config: testConfig(over) });
  await app.ready();
  return { db, app, editionId };
}
