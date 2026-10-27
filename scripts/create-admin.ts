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

/** Interactive terminal: one readline interface, two hidden prompts. Piped stdin: the first two lines. */
async function readTwice(): Promise<[string, string]> {
  const prompts = [
    `Choose a password (at least ${MIN_PASSWORD_LENGTH} characters). Nothing will appear as you type; press Enter when done:`,
    "Type the same password again to confirm:",
  ];
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
    return [lines[0] ?? "", lines[1] ?? lines[0] ?? ""];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined; // nothing is echoed
  const ask = (p: string) => new Promise<string>((resolve) => { console.error(p); rl.question("", resolve); });
  const first = await ask(prompts[0]!);
  const second = await ask(prompts[1]!);
  rl.close();
  return [first, second];
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const [first, second] = await readTwice();
  if (first !== second) { console.error("The two passwords did not match. Nothing was created."); process.exit(1); }
  return first;
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
} catch (err) {
  if ((err as { code?: string }).code === "23505") { console.error(`An administrator with the email ${values.email} already exists. Nothing was changed.`); process.exitCode = 1; }
  else throw err;
} finally { await db.close(); }
