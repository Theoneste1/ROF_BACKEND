import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";
import { seedLocations } from "../src/locations.js";

const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try { console.log(await seedLocations(db)); } finally { await db.close(); }
