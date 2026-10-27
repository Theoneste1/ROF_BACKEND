// One-command, re-runnable database setup:
//   npm run bootstrap -- --year 2026 --name "Rwanda Mathematics Olympiad 2026"
// Applies migrations, loads Rwanda locations, creates the edition if missing (open + current when none is current),
// and loads the school directory. Safe to run repeatedly. The first admin is created separately (needs a password).
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { LocationService, seedLocations } from "../src/locations.js";
import { importSchoolDirectoryCsv } from "../src/schoolDirectory.js";

const { values } = parseArgs({ options: { year: { type: "string" }, name: { type: "string" }, "skip-schools": { type: "boolean" } } });
if (!values.year || !/^\d{4}$/.test(values.year) || !values.name) {
  console.error('Usage: npm run bootstrap -- --year 2026 --name "Rwanda Mathematics Olympiad 2026" [--skip-schools]');
  process.exit(1);
}
const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try {
  const ran = await runMigrations(db);
  console.log(ran.length ? `Migrations applied: ${ran.join(", ")}` : "Migrations: up to date");
  const c = await seedLocations(db);
  console.log(`Locations: ${c.provinces} provinces, ${c.districts} districts, ${c.sectors} sectors, ${c.cells} cells`);

  const existing = (await db.query("SELECT id FROM competition_editions WHERE slug = $1", [values.year])).rows[0];
  if (existing) console.log(`Edition ${values.year}: already exists (left unchanged)`);
  else {
    const hasCurrent = (await db.query("SELECT 1 FROM competition_editions WHERE is_current")).rowCount > 0;
    await db.query("INSERT INTO competition_editions (year, name, slug, registration_open, is_current) VALUES ($1,$2,$3,$4,$5)",
      [Number(values.year), values.name, values.year, !hasCurrent, !hasCurrent]);
    console.log(`Edition ${values.year}: created${hasCurrent ? " (another edition is current; this one is closed and not current)" : " (open and current)"}`);
  }

  if (!values["skip-schools"]) {
    const locations = new LocationService(db); await locations.load();
    const file = new URL("../data/school-directory.csv", import.meta.url);
    const r = await importSchoolDirectoryCsv(db, locations, fs.readFileSync(file, "utf8"), "NESA 2024/25 + ROF list", true);
    console.log(`School directory: ${r.created} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped.length} skipped`);
  }
  const admins = Number((await db.query<{ n: string }>("SELECT count(*) n FROM admin_users")).rows[0]!.n);
  console.log(admins ? `Administrators: ${admins}` : "Administrators: none yet. Run: npm run admin:create -- --email <email> --name \"<name>\" --role super_admin");
} finally { await db.close(); }
