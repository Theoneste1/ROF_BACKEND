import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { seedLocations } from "../src/locations.js";

const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try {
  const ran = await runMigrations(db);
  console.log(ran.length ? `Applied migrations: ${ran.join(", ")}` : "No pending migrations.");
  const counts = await seedLocations(db);
  console.log(`Reference locations up to date: ${counts.provinces} provinces, ${counts.districts} districts, ${counts.sectors} sectors, ${counts.cells} cells.`);
} finally {
  await db.close();
}
