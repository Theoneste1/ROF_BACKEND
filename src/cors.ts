/**
 * Which browser origins may call the API.
 *
 *  - exact origins from CORS_ORIGINS (the production website, any admin UI);
 *  - wildcard patterns from CORS_ORIGIN_PATTERNS, where "*" matches one DNS label made of letters, digits and hyphens
 *    (default: Netlify deploy previews and branch deploys of the registration site);
 *  - local development: http(s)://localhost, 127.0.0.1 and [::1] on any port (CORS_ALLOW_LOCALHOST, default on).
 *
 * This is not an authentication mechanism: the API uses bearer tokens (never cookies), admin routes still need a valid token,
 * and anyone can call the public endpoints directly without a browser. CORS only decides which web pages may read responses.
 */
export const DEFAULT_ORIGIN_PATTERNS = ["https://*--rwandamathcompetition.netlify.app"];

const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** "https://*--site.netlify.app" -> anchored regex; "*" is one label of [a-z0-9-]. */
export function patternToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegex).join("[a-z0-9-]+")}$`, "i");
}

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export interface CorsPolicy { origins: string[]; patterns?: string[]; allowLocalhost?: boolean }

export function isAllowedOrigin(origin: string | undefined, policy: CorsPolicy): boolean {
  if (!origin) return true; // not a browser cross-origin request (curl, server-to-server, same-origin)
  if (policy.origins.includes(origin)) return true;
  if (policy.allowLocalhost !== false && LOCALHOST_RE.test(origin)) return true;
  return (policy.patterns ?? []).some((p) => patternToRegex(p).test(origin));
}
