// Prints a PEM certificate as ONE line with literal "\n" for line breaks, ready to paste into DATABASE_SSL_CA.
// Usage: npm run cert:escape -- path/to/certificate.crt
import fs from "node:fs";
const file = process.argv[2];
if (!file) { console.error("Usage: npm run cert:escape -- <certificate file>"); process.exit(1); }
const pem = fs.readFileSync(file, "utf8").trim();
if (!pem.includes("BEGIN CERTIFICATE")) { console.error("That file does not look like a PEM certificate (no BEGIN CERTIFICATE line)."); process.exit(1); }
console.log(pem.replace(/\r?\n/g, "\\n"));
