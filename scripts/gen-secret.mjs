// Prints a random 64-character secret suitable for JWT_SECRET.
import crypto from "node:crypto";
console.log(crypto.randomBytes(48).toString("base64url"));
