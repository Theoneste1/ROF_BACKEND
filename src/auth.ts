import crypto from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const dk = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

/** Valid hash of a random password, used to equalize timing when the email is unknown. */
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(24).toString("hex")));

export type Role = "viewer" | "admin" | "finance" | "super_admin";
export type Permission =
  | "registrations:read" | "registrations:update" | "registrations:status"
  | "registrations:export" | "registrations:stats"
  | "bank:read" | "bank:write" | "audit:read" | "users:manage";

const PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["registrations:read", "registrations:stats"],
  admin: ["registrations:read", "registrations:update", "registrations:status", "registrations:export", "registrations:stats", "audit:read"],
  finance: ["registrations:read", "registrations:export", "registrations:stats", "bank:read", "bank:write"],
  super_admin: ["registrations:read", "registrations:update", "registrations:status", "registrations:export", "registrations:stats", "bank:read", "bank:write", "audit:read", "users:manage"],
};
export const can = (role: Role, perm: Permission): boolean => PERMISSIONS[role]?.includes(perm) ?? false;
export const isRole = (v: string): v is Role => v in PERMISSIONS;

export interface TokenClaims { sub: string; role: Role; tv: number }

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signToken(secret: string, claims: TokenClaims, ttlSeconds: number): Promise<string> {
  return new SignJWT({ role: claims.role, tv: claims.tv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub).setIssuer("rof-registration").setAudience("rof-admin")
    .setIssuedAt().setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifyToken(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], issuer: "rof-registration", audience: "rof-admin" });
    if (!payload.sub || typeof payload.role !== "string" || !isRole(payload.role) || typeof payload.tv !== "number") return null;
    return { sub: payload.sub, role: payload.role, tv: payload.tv };
  } catch { return null; }
}
