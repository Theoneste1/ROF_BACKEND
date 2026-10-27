import { describe, expect, it } from "vitest";
import { DEFAULT_ORIGIN_PATTERNS, isAllowedOrigin, patternToRegex } from "../src/cors.js";
import { loadConfig } from "../src/config.js";
import { makeApp } from "./helpers.js";

const policy = { origins: ["https://rwandamathcompetition.netlify.app", "https://math.rwandaolympiadfoundation.org"], patterns: DEFAULT_ORIGIN_PATTERNS, allowLocalhost: true };
const allowed = (o: string | undefined, p = policy) => isAllowedOrigin(o, p);

describe("origin policy", () => {
  it("allows the production site and requests with no Origin header (curl, server-to-server)", () => {
    expect(allowed("https://rwandamathcompetition.netlify.app")).toBe(true);
    expect(allowed("https://math.rwandaolympiadfoundation.org")).toBe(true);
    expect(allowed(undefined)).toBe(true);
  });

  it.each([
    "http://localhost:8080", "http://localhost:5173", "http://localhost", "https://localhost:3000",
    "http://127.0.0.1:8080", "http://[::1]:8080",
  ])("allows local development origin %s", (o) => expect(allowed(o)).toBe(true));

  it.each([
    "https://deploy-preview-12--rwandamathcompetition.netlify.app",
    "https://feature-api-registration--rwandamathcompetition.netlify.app",
    "https://develop--rwandamathcompetition.netlify.app",
  ])("allows this site's Netlify preview/branch deploy %s", (o) => expect(allowed(o)).toBe(true));

  it.each([
    "https://evil.example",
    "https://rwandamathcompetition.netlify.app.evil.com",       // suffix trick
    "https://evilrwandamathcompetition.netlify.app",            // no "--" separator
    "https://x--rwandamathcompetition.netlify.app.evil.com",
    "https://a.b--rwandamathcompetition.netlify.app",           // "*" is a single label
    "http://x--rwandamathcompetition.netlify.app",              // wrong scheme
    "https://x--rwandamathcompetition-netlify-app.evil.com",
    "http://localhost.evil.com", "http://localhost:8080.evil.com", "http://127.0.0.1.evil.com", "http://localhost:99999999",
    "https://anything.netlify.app", "https://rwandaolympiadfoundation.org", "https://math.rwandaolympiadfoundation.org.evil.com", "https://evilmath.rwandaolympiadfoundation.org", "http://math.rwandaolympiadfoundation.org", "null", "file://", "",
  ])("blocks %j", (o) => expect(allowed(o || "x://")).toBe(false));

  it("localhost can be switched off and patterns can be emptied", () => {
    expect(allowed("http://localhost:8080", { ...policy, allowLocalhost: false })).toBe(false);
    expect(allowed("https://x--rwandamathcompetition.netlify.app", { ...policy, patterns: [] })).toBe(false);
    expect(allowed("https://rwandamathcompetition.netlify.app", { origins: policy.origins, patterns: [], allowLocalhost: false })).toBe(true);
  });

  it("escapes regex characters in patterns (a dot is a dot)", () => {
    expect(patternToRegex("https://*.example.org").test("https://a.example.org")).toBe(true);
    expect(patternToRegex("https://*.example.org").test("https://a-example-org")).toBe(false);
  });
});

describe("configuration", () => {
  const ok = { DATABASE_URL: "postgres://x", JWT_SECRET: "x".repeat(32) };
  it("defaults to the Netlify preview pattern and localhost", () => {
    const c = loadConfig({ ...ok } as never);
    expect(c.corsOriginPatterns).toEqual(DEFAULT_ORIGIN_PATTERNS);
    expect(c.corsAllowLocalhost).toBe(true);
  });
  it("reads overrides and accepts an empty pattern list", () => {
    expect(loadConfig({ ...ok, CORS_ORIGIN_PATTERNS: "https://*.example.org", CORS_ALLOW_LOCALHOST: "false" } as never))
      .toMatchObject({ corsOriginPatterns: ["https://*.example.org"], corsAllowLocalhost: false });
    expect(loadConfig({ ...ok, CORS_ORIGIN_PATTERNS: "" } as never).corsOriginPatterns).toEqual([]);
  });
  it.each(["*", "https://*", "https://*.com.", "evil", "https://example.org"])("rejects an unsafe pattern %s", (p) => {
    expect(() => loadConfig({ ...ok, CORS_ORIGIN_PATTERNS: p } as never)).toThrow(/CORS_ORIGIN_PATTERNS/);
  });
});

describe("HTTP behaviour (what the browser actually sees)", () => {
  it("answers preflight and real requests for localhost with the permission header, and not for unknown origins", async () => {
    const { app } = await makeApp();
    const pre = (origin: string) => app.inject({ method: "OPTIONS", url: "/api/school-registrations", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,idempotency-key" } });
    expect((await pre("http://localhost:8080")).headers["access-control-allow-origin"]).toBe("http://localhost:8080");
    expect((await pre("https://deploy-preview-3--rwandamathcompetition.netlify.app")).headers["access-control-allow-origin"]).toBe("https://deploy-preview-3--rwandamathcompetition.netlify.app");
    expect((await pre("https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();

    for (const url of ["/api/locations", "/api/registered-schools", "/api/schools?sector_id=x"]) {
      const res = await app.inject({ method: "GET", url, headers: { origin: "http://localhost:8080" } });
      expect(res.headers["access-control-allow-origin"], url).toBe("http://localhost:8080");
    }
    // admin routes stay protected by the token regardless of origin
    const admin = await app.inject({ method: "GET", url: "/api/school-registrations", headers: { origin: "http://localhost:8080" } });
    expect(admin.statusCode).toBe(401);
  });
});
