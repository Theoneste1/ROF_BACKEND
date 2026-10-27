// Read-only checks against a deployed API. Writes nothing.
//   npm run smoke -- https://your-api.onrender.com [https://rwandamathcompetition.netlify.app]
const [base, origin = "https://rwandamathcompetition.netlify.app"] = process.argv.slice(2);
if (!base) { console.error("Usage: npm run smoke -- <api base url> [allowed origin]"); process.exit(1); }
const url = (p: string) => new URL(p, base).toString();
let failed = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  try { const note = await fn(); console.log(`PASS  ${name}${note ? ` — ${note}` : ""}`); }
  catch (e) { failed++; console.log(`FAIL  ${name} — ${(e as Error).message}`); }
}
const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const json = async (r: Response) => r.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

await check("health (API up, database reachable)", async () => { const r = await fetch(url("/health")); expect(r.status === 200, `HTTP ${r.status}`); });
let sectorId = "";
await check("location tree (5 provinces, 30 districts)", async () => {
  const j = await json(await fetch(url("/api/locations")));
  expect(j.provinces?.length === 5, `provinces=${j.provinces?.length}`);
  const districts = j.provinces.flatMap((p: any) => p.districts); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(districts.length === 30, `districts=${districts.length}`);
  sectorId = districts.find((d: any) => d.name === "Gasabo").sectors[0].id; // eslint-disable-line @typescript-eslint/no-explicit-any
});
await check("a current, open competition edition exists", async () => {
  const r = await fetch(url("/api/competition-editions/current")); expect(r.status === 200, `HTTP ${r.status} (run npm run bootstrap)`);
  const j = await json(r); expect(j.registration_open === true, "registration is not open"); return `${j.name}`;
});
await check("school directory is loaded", async () => {
  const j = await json(await fetch(url(`/api/schools?sector_id=${sectorId}`)));
  expect(j.schools?.length > 0, "no schools returned (run npm run bootstrap)"); return `${j.schools.length} schools for a Gasabo sector`;
});
await check("public registered-schools list exposes only school code, name, district and student count", async () => {
  const r = await fetch(url("/api/registered-schools")); expect(r.status === 200, `HTTP ${r.status}`);
  const j = await json(r); expect(Array.isArray(j.schools), "no schools array");
  for (const s of j.schools.slice(0, 200)) expect(Object.keys(s).sort().join() === "district,school_code,school_name,student_count", `unexpected fields: ${Object.keys(s)}`);
  return `${j.total_schools} schools, ${j.total_students} students`;
});
await check("invalid registration is rejected with field errors (nothing saved)", async () => {
  const r = await fetch(url("/api/school-registrations"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(r.status === 422, `HTTP ${r.status}`); const j = await json(r); expect(j.error?.fields?.head_teacher_email, "missing head_teacher_email error");
});
await check("admin endpoints require authentication", async () => {
  for (const p of ["/api/school-registrations", "/api/school-registrations/export", "/api/school-registrations/statistics"])
    expect((await fetch(url(p))).status === 401, `${p} is not protected`);
});
await check(`CORS allows ${origin} and blocks other origins`, async () => {
  const pre = (o: string) => fetch(url("/api/school-registrations"), { method: "OPTIONS", headers: { origin: o, "access-control-request-method": "POST", "access-control-request-headers": "content-type,idempotency-key" } });
  expect((await pre(origin)).headers.get("access-control-allow-origin") === origin, "allowed origin not echoed (check CORS_ORIGINS)");
  expect((await pre("https://evil.example")).headers.get("access-control-allow-origin") === null, "unlisted origin was allowed");
});
await check("security headers present", async () => {
  const h = (await fetch(url("/health"))).headers; expect(h.get("x-content-type-options") === "nosniff", "missing nosniff");
});
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
