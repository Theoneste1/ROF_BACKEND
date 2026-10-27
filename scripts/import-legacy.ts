// Dry run (default):  npm run import:legacy -- --file sheet.csv --edition 2026
// Write to database:  npm run import:legacy -- --file sheet.csv --edition 2026 --apply
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";
import { LocationService } from "../src/locations.js";
import { importLegacyCsv } from "../src/legacyImport.js";

const { values } = parseArgs({ options: { file: { type: "string" }, edition: { type: "string" }, apply: { type: "boolean" } } });
if (!values.file || !values.edition) { console.error("Usage: --file <csv> --edition <edition slug> [--apply]"); process.exit(1); }
const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try {
  const locations = new LocationService(db); await locations.load();
  const report = await importLegacyCsv(db, locations, fs.readFileSync(values.file, "utf8"), values.edition, !!values.apply);
  console.log(values.apply ? "APPLIED" : "DRY RUN (nothing written)", JSON.stringify(report, null, 2));
} finally { await db.close(); }
