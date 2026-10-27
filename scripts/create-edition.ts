// Usage: npm run edition:create -- --year 2026 --name "Rwanda Mathematics Olympiad 2026" [--open] [--current]
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";

const { values } = parseArgs({ options: { year: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, open: { type: "boolean" }, current: { type: "boolean" } } });
if (!values.year || !/^\d{4}$/.test(values.year) || !values.name) {
  console.error('Usage: npm run edition:create -- --year 2026 --name "Rwanda Mathematics Olympiad 2026" [--slug 2026] [--open] [--current]');
  process.exit(1);
}
const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try {
  await db.transaction(async (tx) => {
    if (values.current) await tx.query("UPDATE competition_editions SET is_current = false WHERE is_current");
    const r = await tx.query(
      "INSERT INTO competition_editions (year, name, slug, registration_open, is_current) VALUES ($1,$2,$3,$4,$5) RETURNING id, slug",
      [Number(values.year), values.name, values.slug ?? values.year, !!values.open, !!values.current]);
    console.log("Created edition", r.rows[0]);
  });
} finally { await db.close(); }
