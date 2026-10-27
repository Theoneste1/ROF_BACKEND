import "dotenv/config";

import { DEFAULT_ORIGIN_PATTERNS } from "./cors.js";

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  databaseSsl: boolean;
  /** PEM of the database's CA certificate (Supabase uses its own CA, which Node does not trust by default). */
  databaseSslCa?: string;
  /** Set DATABASE_SSL_REJECT_UNAUTHORIZED=false only as a last resort: encrypts but does not verify the server. */
  databaseSslRejectUnauthorized: boolean;
  jwtSecret: string;
  jwtTtlSeconds: number;
  corsOrigins: string[];
  /** Wildcard origins, e.g. https://*--site.netlify.app ("*" = one DNS label). */
  corsOriginPatterns: string[];
  /** Allow http(s)://localhost, 127.0.0.1 and [::1] on any port (local development). */
  corsAllowLocalhost: boolean;
  trustProxy: boolean;
  publicRateLimitMax: number;
  publicRateLimitWindowMs: number;
  loginRateLimitMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? "development";
  const missing: string[] = [];
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) missing.push(k); return v ?? ""; };
  const databaseUrl = need("DATABASE_URL");
  const jwtSecret = need("JWT_SECRET");
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters.");
  const corsOrigins = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const corsOriginPatterns = env.CORS_ORIGIN_PATTERNS === undefined
    ? DEFAULT_ORIGIN_PATTERNS
    : env.CORS_ORIGIN_PATTERNS.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of corsOriginPatterns)
    if (!/^https?:\/\/[^*]*\*[a-z0-9.-]*\.[a-z]{2,}$/i.test(p)) throw new Error(`CORS_ORIGIN_PATTERNS entry "${p}" must look like https://*--your-site.netlify.app`);
  if (nodeEnv === "production" && corsOrigins.includes("*")) throw new Error("CORS_ORIGINS must list explicit origins in production.");
  return {
    nodeEnv,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl,
    databaseSsl: env.DATABASE_SSL ? env.DATABASE_SSL === "true" : nodeEnv === "production",
    databaseSslCa: env.DATABASE_SSL_CA?.trim() ? env.DATABASE_SSL_CA.replace(/\\n/g, "\n") : undefined,
    databaseSslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
    jwtSecret,
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 7200),
    corsOrigins,
    corsOriginPatterns,
    corsAllowLocalhost: env.CORS_ALLOW_LOCALHOST !== "false",
    trustProxy: env.TRUST_PROXY === "true",
    publicRateLimitMax: Number(env.PUBLIC_RATE_LIMIT_MAX ?? 10),
    publicRateLimitWindowMs: Number(env.PUBLIC_RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000),
    loginRateLimitMax: Number(env.LOGIN_RATE_LIMIT_MAX ?? 10),
  };
}
