/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";
import { createPgDb, type Db } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { seedLocations } from "../src/locations.js";
import { buildApp } from "../src/app.js";
import { createEdition, testConfig, validPayload } from "./helpers.js";

/**
 * Exercises the production `pg` driver adapter (createPgDb) end to end against a real
 * PostgreSQL wire-protocol endpoint (PGlite served over TCP), which the in-process adapter used
 * by the other suites does not cover: pooled connections, BEGIN/COMMIT/ROLLBACK, multi-statement exec.
 */
let pg: PGlite; let server: PGLiteSocketServer; let db: Db; let app: FastifyInstance;

beforeAll(async () => {
  pg = await PGlite.create();
  server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
  await server.start();
  const addr = (server as any).server.address();
  db = createPgDb(`postgres://postgres:postgres@127.0.0.1:${addr.port}/postgres`, { max: 3 });
  await runMigrations(db);
  await seedLocations(db);
  await createEdition(db);
  app = await buildApp({ db, config: testConfig() });
}, 120_000);

afterAll(async () => { await app?.close(); await db?.close(); await server?.stop(); await pg?.close(); });

describe("pg driver adapter", () => {
  it("applied migrations and seeded locations over the wire", async () => {
    expect((await db.query("SELECT count(*)::int n FROM sectors")).rows[0]!.n).toBe(416);
    expect((await db.query("SELECT name FROM schema_migrations")).rows).toEqual([{ name: "001_init.sql" }, { name: "002_cells_and_school_directory.sql" }, { name: "003_directory_district_level.sql" }]);
  });
  it("saves a registration and returns correct rowCount/rows", async () => {
    const res = await app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload() as any });
    expect(res.statusCode).toBe(201);
    const r = await db.query("SELECT total_estimated_students t, school_code FROM school_registrations");
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toEqual({ t: 30, school_code: "012345" });
  });
  it("commits on success and rolls back on error", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO schools (school_code, school_code_normalized, name) VALUES ('rb','rb','x')");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await db.query("SELECT 1 FROM schools WHERE school_code='rb'")).rowCount).toBe(0);
    await db.transaction(async (tx) => { await tx.query("INSERT INTO schools (school_code, school_code_normalized, name) VALUES ('ok','ok','x')"); });
    expect((await db.query("SELECT 1 FROM schools WHERE school_code='ok'")).rowCount).toBe(1);
  });
  it("reports unique violations with code 23505 so idempotency races are recognised", async () => {
    await expect(db.query("INSERT INTO schools (school_code, school_code_normalized, name) VALUES ('ok','ok','dup')"))
      .rejects.toMatchObject({ code: "23505" });
  });
  it("handles concurrent identical submissions on separate pooled connections", async () => {
    const payload = validPayload({ school_code: "424242" });
    const results = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: "POST", url: "/api/school-registrations", payload: payload as any })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM school_registrations WHERE school_code='424242'")).rowCount).toBe(1);
  });
  it("migration runner is a no-op on re-run", async () => {
    expect(await runMigrations(db)).toEqual([]);
  });
});
