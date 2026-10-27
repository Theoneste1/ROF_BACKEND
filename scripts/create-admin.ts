// Usage: npm run admin:create -- --email you@example.org --name "Full Name" --role super_admin
// The password is read from ADMIN_PASSWORD or prompted (hidden). It is never accepted as a CLI argument,
// so it cannot end up in shell history or process listings.
import { parseArgs } from "node:util";
import readline from "node:readline";
import { loadConfig } from "../src/config.js";
import { createPgDb } from "../src/db.js";
import { MIN_PASSWORD_LENGTH, hashPassword, isRole } from "../src/auth.js";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" } } });
const role = values.role ?? "super_admin";
if (!values.email || !values.name || !isRole(role)) {
  console.error("Usage: npm run admin:create -- --email <email> --name <full name> --role <viewer|admin|finance|super_admin>");
  process.exit(1);
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void });
  return new Promise((resolve) => {
    process.stdout.write("Password: ");
    write._writeToOutput = () => undefined;
    rl.question("", (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const password = await readPassword();
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}
const config = loadConfig();
const db = createPgDb(config.databaseUrl, { ssl: config.databaseSsl, ca: config.databaseSslCa, rejectUnauthorized: config.databaseSslRejectUnauthorized });
try {
  const r = await db.query(
    "INSERT INTO admin_users (email, full_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, role",
    [values.email.trim().toLowerCase(), values.name, await hashPassword(password), role]);
  console.log("Created administrator:", r.rows[0]);
} finally { await db.close(); }
