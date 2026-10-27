import "dotenv/config";

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
    trustProxy: env.TRUST_PROXY === "true",
    publicRateLimitMax: Number(env.PUBLIC_RATE_LIMIT_MAX ?? 10),
    publicRateLimitWindowMs: Number(env.PUBLIC_RATE_LIMIT_WINDOW_MS ?? 10 * 60 * 1000),
    loginRateLimitMax: Number(env.LOGIN_RATE_LIMIT_MAX ?? 10),
  };
}
