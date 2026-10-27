// Dry run (default):  npm run import:schools -- --file schools.csv --source "MINEDUC 2026 list"
// Write to database:  npm run import:schools -- --file schools.csv --source "MINEDUC 2026 list" --apply
// CSV columns: school_name, province, district, sector [, cell, school_code, school_type]
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";
import { LocationService } from "../src/locations.js";
import { importSchoolDirectoryCsv } from "../src/schoolDirectory.js";

const { values } = parseArgs({ options: { file: { type: "string" }, source: { type: "string" }, apply: { type: "boolean" } } });
if (!values.file || !values.source) { console.error('Usage: --file <csv> --source "<where the list comes from>" [--apply]'); process.exit(1); }
const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try {
  const locations = new LocationService(db); await locations.load();
  const report = await importSchoolDirectoryCsv(db, locations, fs.readFileSync(values.file, "utf8"), values.source, !!values.apply);
  console.log(values.apply ? "APPLIED" : "DRY RUN (nothing written)", JSON.stringify(report, null, 2));
} finally { await db.close(); }
