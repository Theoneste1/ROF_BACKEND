# ROF Registration Backend

Backend API for the Rwanda Mathematics Olympiad school registration form
(<https://rwandamathcompetition.netlify.app/competitions/register>), run by the Rwanda Olympiad Foundation.

Node 20+ · TypeScript · Fastify · PostgreSQL (Supabase-compatible). No frontend code lives here.

> **Status:** deployed on Render and backed by Supabase PostgreSQL. The website's registration form and Registered Schools page
> read and write only this API; there is no Google Sheet or Apps Script anywhere in the registration flow.
> See [Deployment](#deployment) and [docs/frontend-integration.md](docs/frontend-integration.md).

## Why a standalone service

The website (`olympiadProduction`, Vite + React on Netlify) is static, so registrations need a server that validates them, keeps
secrets (database credentials, JWT secret) out of the browser, and protects personal and bank data. This service stores
registrations in PostgreSQL. The SQL migrations are plain PostgreSQL and every object they create has a distinct name, so they
can share a Supabase project with other tables without altering them.

## Quick start (local)

```bash
npm install
cp .env.example .env            # fill in DATABASE_URL and JWT_SECRET
npm run migrate                 # applies migrations + loads Rwanda provinces/districts/sectors
npm run edition:create -- --year 2026 --name "Rwanda Mathematics Olympiad 2026" --open --current
npm run admin:create -- --email you@example.org --name "Your Name" --role super_admin   # prompts for password
npm run dev                     # http://localhost:8787
```

No Postgres installed? `npm run dev:db` serves a throw-away in-memory Postgres on `127.0.0.1:5544`
(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5544/postgres`).

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Server-side Postgres connection string. Never the Supabase anon key. |
| `JWT_SECRET` | yes | ≥ 32 random characters. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DATABASE_SSL` | no | Defaults to `true` in production, `false` otherwise. |
| `CORS_ORIGINS` | no | Extra exact browser origins (any admin UI). The two website addresses, `https://rwandamathcompetition.netlify.app` and `https://math.rwandaolympiadfoundation.org`, are always allowed. `*` is refused in production. |
| `CORS_ORIGIN_PATTERNS` | no | Wildcard origins, `*` = one DNS label. Default `https://*--rwandamathcompetition.netlify.app` (this site's Netlify deploy previews and branch deploys). Empty disables. |
| `CORS_ALLOW_LOCALHOST` | no | Default `true`: `http(s)://localhost`, `127.0.0.1` and `[::1]` on any port may call the API (local development). CORS is not authentication: admin routes still need a token. |
| `TRUST_PROXY` | no | `true` behind a proxy/PaaS so rate limiting sees the real client IP. |
| `PORT`, `HOST` | no | Default `8787`, `0.0.0.0`. |
| `JWT_TTL_SECONDS` | no | Default 7200. |
| `PUBLIC_RATE_LIMIT_MAX` / `_WINDOW_MS` | no | Public submissions per IP; default 10 per 10 min. |
| `LOGIN_RATE_LIMIT_MAX` | no | Login attempts per IP per minute; default 10. |

Secrets live only in the server environment. `.env` is git-ignored.

## Creating the first administrator

```bash
npm run admin:create -- --email <email> --name "<full name>" --role super_admin
```

The password (min 12 chars) is prompted for with hidden input, or read from `ADMIN_PASSWORD` for automation.
It is deliberately **not** accepted as a CLI argument (shell history / process list). Passwords are stored as
scrypt hashes. Roles: `viewer`, `admin`, `finance`, `super_admin` (see [Roles](#roles-and-permissions)).
Create the first one from a trusted machine with direct database access; there is no public sign-up route.

## Database

Migration: [`migrations/001_init.sql`](migrations/001_init.sql). The runner records a checksum per migration and
refuses to run if an applied file was edited (add a new numbered file instead). Each migration runs in a transaction.

```
competition_editions 1──* school_registrations *──1 schools          (stable school identity, unique per school code)
provinces 1──* districts 1──* sectors 1──* cells                      (reference data, 5 / 30 / 416 / 2,148)
school_directory ──> sector, cell                                     (pick-list of known schools; name + optional code)
school_registrations ──> province, district (must belong to province), sector (must belong to district), cell (must belong to sector)   [composite FKs]
admin_users                                                           (staff accounts)
audit_log                                                             (append-only; UPDATE/DELETE/TRUNCATE blocked by trigger)
```

Key decisions

- **One row per submission** in `school_registrations`, holding a full snapshot of what was submitted, linked to the edition and to a stable `schools` row. A school registers again next year as a *new* row; history is never overwritten.
- **School code is unique on `schools`, never on registrations.** Same-edition repeats are *flagged*, not blocked.
- `total_estimated_students` is a **generated column** (`p5_p6 + s1_s3 + s4_s5`); clients cannot set it.
- Text everywhere for codes, phones, accounts → leading zeros survive.
- Required fields are enforced by a CHECK for new registrations (`is_legacy = false`, the default). The `is_legacy` and `legacy_raw` columns exist in the first migration but nothing uses them.
- Head teacher (`head_teacher_*`), registering contact, maths teacher (`mathematics_teacher_*`), `test_delivery_email`, school bank and teacher bank are all separate columns.
- **RLS is enabled on every table with no policies** and `anon`/`authenticated` privileges are revoked (when those Supabase roles exist), so the public Supabase API can read or write nothing here. Only this service, connecting with the owner/service role, touches the tables.
- Location lists come from [`data/rwanda-locations.json`](data/rwanda-locations.json): 5 provinces, 30 districts, 416 sectors, 2,148 cells, with stable codes. It was generated from the MIT-licensed npm packages `rwanda-geo@1.4.6` and `rwanda-locations@1.2.2`; the two independent datasets agree exactly on every district's sector list and every sector's cell list, and the 30 districts match the live form. Re-seeding (`npm run locations:seed`) is idempotent and only renames by code, never deletes. Province spellings used by the form (`Kigali`, `Southern`, …) and official names (`Kigali City`, `Southern Province`) are both accepted.

### Province → District → Sector → Cell → School (auto-filled code)

1. `GET /api/locations` → provinces, districts, sectors. 2. `GET /api/locations/sectors/:sectorId/cells` → cells of the chosen sector.
3. `GET /api/schools?sector_id=…[&cell_id=…][&q=…]` → schools known for that area: `{ schools: [{ id, name, school_code | null, school_type | null, cell_id | null }], manual_entry_allowed: true }`.
4. On submit, send `directory_school_id` (the picked school's `id`). The server then **takes the school name and, if the directory has one, the school code from the directory**
   (the client may omit both; a conflicting code is rejected). If the picked school has **no code on file**, `school_code` is required and must be typed.
5. **School not listed?** Omit `directory_school_id` and send `school_name` and `school_code` manually, exactly as before.

`cell` is optional but, when given, must belong to the sector (also enforced by the database). A directory school must belong to the chosen sector, and to the chosen cell when both are known.

**School list source.** [`data/school-directory.csv`](data/school-directory.csv) holds **4,190 schools** (official 6-digit code, name, district; plus sector, cell and school type where known), built by
`scripts/merge-school-sources.mjs` from two lists:

1. **NESA exam results 2024/25**, the latest school-level lists published ([PLE](https://www.nesa.gov.rw/fileadmin/user_upload/NESA/Announcements/Performance_of_schools_in_2024_2025_PLE_and_O-Level_national_examinations/P6_Performance_of_Schools_in_the_2024-2025_Primary_Leaving_Examinations__PLE__Final.pdf): 3,690 primary schools; [O-Level](https://www.nesa.gov.rw/fileadmin/user_upload/NESA/Announcements/Performance_of_schools_in_2024_2025_PLE_and_O-Level_national_examinations/S3_Performance_of_Schools_in_the_2024-2025_Ordinary_Level_National_Examinations_Final.pdf): 1,888 secondary schools) → [`data/schools-nesa-2024-25.csv`](data/schools-nesa-2024-25.csv), extracted with `scripts/extract-nesa-schools.mjs`. Gives code, name and district only.
2. **The school list supplied by ROF** (secondary, TVET and teacher-training schools: 1,974 schools with sector, school type and, for day schools, cell) → [`data/sources/rof-school-list.csv`](data/sources/rof-school-list.csv).

Merge rules (all checked by the script, which aborts or reports instead of guessing):

- **Cross-validation:** the district implied by each school code's first two digits (learned from the NESA list) must equal the district in the ROF list. It matched for all 1,974 schools.
- **Sectors and cells must exist** in the official location data. 1,974/1,974 sectors resolved; 1,631 cells resolved (1,617 exact, 5 via the alias table, 9 as the *unique* cell starting with a truncated name such as `Rwanyamuhang`). One cell (`Gaseke`, Gacurabwenge, Kamonyi) is not in the location data, so that school is kept with its sector but no cell.
- **Names:** for schools in both lists the NESA name is kept (the ROF list often omits the "GS"/"EP" prefix; 49 differ); the ROF name is used for the 186 schools NESA does not list.
- **Spelling variants** found in the ROF list are in `data/location-aliases.json` (`Mageregere` → `Mageragere`, cell `Munini` → `Umunini`). Two typos in the npm location packages were **corrected** in `data/rwanda-locations.json` after checking the NISR census sector table: Bugesera `Ririma` → `Rilima`, Burera `Rugendabari` → `Rugengabari`.

What this means for the picker:

- **Secondary/TVET/TTC schools** (1,974) are tied to their sector (and cell for day schools), so they appear first for the registrant's sector/cell.
- **Primary schools and others only in the NESA list** (2,216) are known at district level only: they are offered for every sector of their district, searchable by name. NESA publishes no sector for them.
- **Coverage is not "every school"**: only schools that sat the 2024/25 national exams, or are in ROF's list, are present. No nursery-only schools, new schools or schools without a candidate cohort. That is why **manual entry stays available** at every step.
- NESA also runs an *accredited schools* register (ireme.nesa.gov.rw) whose public page reads from an API protected by a key embedded in the site's code. That key was issued for NESA's website, so I did not use it. If ROF wants that list, ask NESA for an export or API access and load it with the same importer.
- The latest published school-level results are 2024/25; I found no 2025/26 results.

Load it (re-runnable; dry run first):

```bash
npm run import:schools -- --file data/school-directory.csv --source "NESA 2024/25 + ROF list"           # dry run
npm run import:schools -- --file data/school-directory.csv --source "NESA 2024/25 + ROF list" --apply   # write
```

Other lists work too: CSV columns `school_name, province, district [, sector, cell, school_code, school_type]`. A row with a sector/cell narrows the school to that place; two schools with the same name are both kept when their codes differ.

**Manual entry.** If the school isn't listed (or has no code on file) the registrant types the name and code; the API accepts that with `directory_school_id` omitted. Admins can review those with `GET /api/school-registrations?in_directory=false` and add real schools to the directory with the next import. Typed-in schools are deliberately *not* added to the public list automatically (anyone could pollute it).


### Duplicate detection

Computed live (never stored, so it can't go stale): another registration in the **same edition**, not rejected/withdrawn, with the
same normalized school code, **or** the same normalized school name in the same district. Surfaced as
`has_potential_duplicates` on list rows, `potential_duplicates[]` (with reasons) on detail, and the `potential_duplicates=true` filter.
Shared teacher emails and merely similar names are not treated as duplicates. Nothing is ever auto-deleted or merged.

### Retries / idempotency

- Send an `Idempotency-Key` header (8–128 chars) to make retries safe: same key + same payload → the original registration (HTTP 200, `replayed: true`); same key + different payload → 409.
- Without a key, a byte-identical (after normalization) payload received within 24 h in the same edition is treated as a repeated delivery of the same request and returns the original registration. A different payload is a new registration.
- Concurrent identical requests are serialised with a transaction-scoped advisory lock.

## API

All bodies are JSON (`Content-Type: application/json`, max 64 KB). Errors: `{ "error": { "code", "message", "fields?" } }`.
Admin routes need `Authorization: Bearer <token>`.

### Public

| Method & path | Description |
|---|---|
| `POST /api/school-registrations` | Submit a registration. `201` new / `200` replay → `{ message, replayed, registration: { id, registration_reference, status, total_estimated_students, competition_edition, created_at } }`. `422` with per-field `fields`; `409 registration_closed`; `409 idempotency_key_reused`; `429` rate-limited. A non-empty `website` field (honeypot) is silently dropped with `202`. |
| `GET /api/locations` | Province → district → sector tree (ids + names) for dropdowns. |
| `GET /api/locations/sectors/:sectorId/cells` | Cells of one sector. |
| `GET /api/registered-schools` | Public list for the website's "Registered Schools" page: one row per school of the current edition (or `?edition_id=`) with `school_code`, `school_name`, `district`, `student_count` (latest registration; rejected/withdrawn excluded) plus totals. No personal data; always revalidated (never served stale); 60 requests/min per IP. Note it shows names as registrants typed them, so admins should reject abusive entries. |
| `GET /api/schools` | School pick-list for a sector: schools recorded for it plus those known only at district level (+ optional `cell_id`, `q`); see the cascade section. |
| `GET /api/competition-editions/current` | Current edition and whether registration is open. |
| `GET /health` | Liveness + DB check. |
| `POST /api/auth/login` | `{ email, password }` → `{ token, expires_in, user }`. 5 failures lock the account for 15 min. |

Request fields (snake_case; required unless noted): `first_name`, `last_name`, `email_address`, `phone_contact`, `school_role`
(`Teacher | Head Teacher | Deputy Head Teacher | Director of Studies | Other`), `school_name`, `school_code` (digits), `school_type`
(`Public | Government Aided | Private`), `province`, `district`, `sector`, *optional* `cell`, `directory_school_id` (then `school_name`/`school_code` become optional, see above), *optional* `school_bank_name`, `school_bank_account`,
`head_teacher_first_name`, `head_teacher_last_name`, `head_teacher_email`, `head_teacher_phone`, `mathematics_teacher_first_name`,
`mathematics_teacher_last_name`, `mathematics_teacher_email`, `mathematics_teacher_phone`, `test_delivery_email`,
*optional* `teacher_bank_name`, `mathematics_teacher_account_number`, `students_p5_p6`, `students_s1_s3`, `students_s4_s5`
(non-negative integers, 0 allowed, numeric strings accepted), *optional* `questions_comments_concerns_feedback`, `additional_information`.
Unknown or system fields (`status`, `id`, totals, …) are ignored. Phones are normalised to `+250…` (Rwanda mobile `07[2389]…`/landline `02…`) or E.164 for other countries.

### Administration

| Method & path | Permission | Description |
|---|---|---|
| `GET /api/school-registrations` | read | Paginated list. Query: `page`, `page_size` (≤100), `q` (school name/code, reference, any contact/teacher/headteacher name or email; multiple words are ANDed), `edition_id`, `province`, `district`, `sector`, `cell` (name or id), `school_type`, `status`, `incomplete`, `potential_duplicates`, `in_directory`, `created_from`, `created_to`, `sort` (`created_at|school_name|total_estimated_students|status|registration_reference`), `order`. |
| `GET /api/school-registrations/:id` | read | Full record + `potential_duplicates` + `school_registration_history`. `?reveal_bank=true` shows full bank numbers (needs `bank:read`; audited). |
| `PATCH /api/school-registrations/:id` | update / bank:write | Update permitted fields (same validation; location re-validated; totals recalculated). Bank fields need `bank:write`, others `registrations:update`. Audited with before/after (bank values never logged). |
| `PATCH /api/school-registrations/:id/status` | status | `{ status, note? }`; `note` required for `rejected`/`withdrawn`. Statuses: `pending, under_review, verified, approved, rejected, withdrawn`. |
| `GET /api/school-registrations/export` | export | CSV honouring the list filters. `include_bank=true` needs `bank:read`. `excel_safe` (default `true`) writes codes/phones/accounts as `="0123"` so Excel keeps leading zeros; `false` gives raw values. Formula-injection characters are neutralised; UTF-8 BOM included. Audited. |
| `GET /api/school-registrations/statistics` | stats | Aggregates only (no personal data): totals, per-group student sums, by status/province/district/school type, incomplete & duplicate counts. Defaults to the current edition; `edition_id=all` for everything. Student totals exclude rejected/withdrawn. |
| `GET /api/school-registrations/:id/audit` | audit | Audit entries for a registration. |
| `GET /api/auth/me` | any | Current user. |

### Roles and permissions

| Role | Can do |
|---|---|
| `viewer` | read (no bank data), statistics |
| `admin` | read, edit non-bank fields, change status, export (no bank data), statistics, audit |
| `finance` | read incl. masked/revealed bank data, edit bank fields, export incl. bank data, statistics |
| `super_admin` | everything |

Roles are always read from the database, never trusted from the token. Bumping `admin_users.token_version` or setting
`is_active = false` revokes tokens immediately. Bank account numbers are masked in lists/details (`*********111`), absent for roles without `bank:read`, excluded from default exports, and never written to logs or the audit trail.

## Security summary

Server-side validation of every field; parameterised SQL only; sort columns whitelisted; `LIKE` wildcards escaped; helmet headers; strict CORS allow-list; per-IP rate limits on submission and login; honeypot; body-size cap; JSON-only; account lockout, constant-time-ish login, scrypt hashing, short-lived HS256 JWTs; RBAC + per-field bank gating; append-only audit log; request logs record method/path/IP only (no bodies, no query strings, no `Authorization`); generic 500s that never leak internals; RLS deny-all on all tables.

Retention / privacy (to be confirmed by ROF): registrations contain contact details of school staff and optional bank details. Suggested policy: keep registrations for the current and previous edition, then anonymise contact and bank columns for older editions via a reviewed migration; restrict `finance`/`super_admin` to named staff; rotate `JWT_SECRET` if a laptop with `.env` is lost.

## Testing

```bash
npm test            # 11 files, 292 tests (PGlite = real PostgreSQL in WASM; no external services)
npm run typecheck && npm run lint && npm run build
```

Covers: schema/migrations/constraints/RLS, validation of every field, geography, registration create/retry/concurrency/rollback,
auth & lockout & token attacks, RBAC, bank-data protection, search/filter/pagination/sort, duplicates, updates, status, statistics,
CSV export (leading zeros, formula injection), audit log, school-directory import, config, the production `pg` driver adapter over the wire, and a real-HTTP end-to-end flow.

## Deployment

The service is a plain Node process (`npm run build && npm start`) that needs Postgres reachable via `DATABASE_URL`. Netlify only hosts static
sites, so run this on any Node host behind HTTPS. [`render.yaml`](render.yaml) is a ready Render Blueprint (use **one** instance: rate limiting is in-memory).

1. **Database (staging first).** Create a *separate* Supabase project. Copy the **Session pooler** connection string (the direct one is IPv6-only and often unreachable from hosts) and the project's SSL certificate (Project Settings → Database).
2. **API.** Render → New → Blueprint → this repo. Enter the secrets it asks for: `DATABASE_URL`, `DATABASE_SSL_CA` (certificate text with line breaks written as `
`; Node does not trust Supabase's CA by default) and `JWT_SECRET` (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`). `CORS_ORIGINS` is preset to the Netlify site.
3. **Prepare the database** from your computer (a git-ignored `.env` with the same `DATABASE_URL`, `DATABASE_SSL=true`, `DATABASE_SSL_CA`, any 32+ character `JWT_SECRET`):
   ```bash
   npm run bootstrap -- --year 2026 --name "Rwanda Mathematics Olympiad 2026"   # migrations + locations + edition + 4,190 schools; re-runnable
   npm run admin:create -- --email you@example.org --name "Your Name" --role super_admin   # asks for a password (hidden)
   ```
4. **Verify the live API** (read-only, writes nothing): `npm run smoke -- https://<your-api-url>`. Every line should say PASS.
5. The website is connected through [docs/frontend-integration.md](docs/frontend-integration.md).
6. **Production:** repeat with a separate production database, after a backup.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `self-signed certificate in certificate chain` | Set `DATABASE_SSL_CA` to Supabase's certificate (last resort: `DATABASE_SSL_REJECT_UNAUTHORIZED=false`, which encrypts but does not verify). |
| `ENOTFOUND` / `ETIMEDOUT` / `ENETUNREACH` to the database | Use the **Session pooler** string, not the direct connection. |
| Browser says "blocked by CORS" / the form says it couldn't load the provinces | The page's origin is not allowed. `localhost`, `127.0.0.1` and this site's Netlify previews are allowed by default; for any other address add the exact origin (no trailing slash) to `CORS_ORIGINS`. |
| Registration returns `409 registration_closed` | No open, current edition: run `npm run bootstrap`. |
| `Missing required environment variables` at start | Set `DATABASE_URL` and `JWT_SECRET` (≥ 32 chars) on the host. |
| `Migration … was modified after being applied` | Never edit an applied migration; add a new numbered file. |

Not covered by this repository: hosting accounts, DNS, backups, monitoring.
