import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ and dist/src/ are both two levels below the project root's migrations/ folder... resolve robustly.
export function migrationsDir(): string {
  for (const rel of ["../migrations", "../../migrations"]) {
    const p = path.resolve(here, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error("migrations directory not found");
}

/**
 * Applies pending migrations in filename order, each in its own transaction, and records
 * a checksum so an already-applied migration that was edited afterwards is detected.
 */
export async function runMigrations(db: Db, dir = migrationsDir()): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map((await db.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const prev = applied.get(file);
    if (prev) {
      if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied. Add a new migration instead.`);
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      });
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
    ran.push(file);
  }
  return ran;
}
