# Connecting the existing form to the backend

**Not applied.** The production frontend lives in a separate repository (`olympiadProduction`) that deploys the live site, so it was
deliberately left untouched. This is the exact change needed, to be reviewed and applied there.

## What changes

1. **`src/utils/schoolRegistrationSubmit.ts`** — replace the Apps Script `fetch(... no-cors ...)` + CSV polling with one call to the API:

```ts
const API = import.meta.env.VITE_REGISTRATION_API_URL as string; // e.g. https://api.example.org

export async function submitSchoolRegistration(payload: RegistrationApiPayload, idempotencyKey: string) {
  const res = await fetch(`${API}/api/school-registrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (res.ok) return body.registration as { id: string; registration_reference: string };
  const err = new Error(body?.error?.message ?? "Registration failed") as Error & { fields?: Record<string, string> };
  err.fields = body?.error?.fields; // map to the form's inline errors
  throw err;
}
```

Generate `idempotencyKey` once per form mount (`crypto.randomUUID()`) and reuse it on retries, so a double click or flaky network cannot create two registrations.
Because the response is now readable (the API sends CORS headers), the "poll the public sheet to verify" logic can go, and the success toast can show `registration_reference`.

2. **`src/pages/CompetitionRegistration.tsx`** — build the payload (field mapping below). The form must also collect the **head teacher's first name, last name and phone**
   (it currently only asks for the head teacher's email). That is the one unavoidable form addition; the API rejects registrations without them. Reuse the existing input components.
   Server validation errors come back per field (`error.fields`) and can be shown with the existing `FieldError`.

3. **Duplicate-code pre-check** — `fetchExistingSchoolCodes()` reads the public sheet (including bank accounts). Remove it: the API accepts a repeated school code and flags it for admin review instead of blocking a legitimate registration.

4. Set `VITE_REGISTRATION_API_URL` in Netlify and add the site origin to the API's `CORS_ORIGINS`.

## Location cascade and school picker

Replace the free-text sector input and the manual school fields with this flow (existing Select components are fine):

1. Province → District → Sector from `GET /api/locations`.
2. Cell: `GET /api/locations/sectors/{sectorId}/cells` (optional field).
3. School: `GET /api/schools?sector_id={sectorId}&cell_id={cellId}` → a searchable select, plus an "My school is not listed" option.
4. Picking a school sets `directory_school_id` and fills the school code **read-only** with `school_code` from the list. If `school_code` is `null`, or the school is not listed, show the code input for manual entry (and the name input when not listed).
5. Submit `directory_school_id` (when picked), `cell`, and `school_name`/`school_code` only when typed manually. The server re-checks everything, so a tampered client cannot attach a wrong code to a directory school.

The directory holds 4,190 schools once loaded (`npm run import:schools`, see the README). About 1,970 secondary/TVET schools are tied to a sector (and cell for day schools); the other ~2,200 (mostly primary) are known only at district level, so a sector can show 100–200 schools: make the select **searchable** (the API also takes `q`) and let the user clear the cell filter, because a school recorded under another cell of the same sector is hidden once a cell is chosen. Always keep the "My school is not listed" option.

## Field mapping (`FormState` → API)

| Form state | API field |
|---|---|
| `firstName`, `lastName` | `first_name`, `last_name` (no longer concatenated into "full name") |
| `email`, `phone`, `role` | `email_address`, `phone_contact`, `school_role` |
| `schoolName`, `schoolCode`, `schoolType` | `school_name`, `school_code`, `school_type` |
| `province`, `district`, `sector` | `province`, `district`, `sector` (labels as shown in the form are accepted) |
| *(new)* cell, picked school | `cell`, `directory_school_id` |
| `schoolBankName`, `schoolBankAccount` | `school_bank_name`, `school_bank_account` |
| *(new)* head teacher first/last name, phone | `head_teacher_first_name`, `head_teacher_last_name`, `head_teacher_phone` |
| `headTeacherEmail` | `head_teacher_email` (now required) |
| `teacherFirstName`, `teacherLastName`, `teacherEmail`, `teacherPhone` | `mathematics_teacher_first_name`, `_last_name`, `_email`, `_phone` |
| `testEmail` | `test_delivery_email` |
| `teacherBankName`, `teacherBankAccount` | `teacher_bank_name`, `mathematics_teacher_account_number` |
| `primaryStudentCount`, `juniorStudentCount`, `seniorStudentCount` | `students_p5_p6`, `students_s1_s3`, `students_s4_s5` |
| `comments`, `additionalInfo` | `questions_comments_concerns_feedback`, `additional_information` |

This mapping is executable: `formToApiPayload` in [`tests/e2e.test.ts`](../tests/e2e.test.ts) submits the form's own string values over real HTTP and verifies every field is stored.

## Other things to resolve on the frontend side (found during inspection)

- **Sector** is free text in the form, but the API validates it against the official 416 sectors. Switch it to a dropdown (see the cascade section above).
- **`RegisteredSchools` page** only *displays* school code, name, district and student count, but it gets them by downloading the whole Google Sheet as CSV from the browser without credentials. That means the sheet (which also holds contacts and bank accounts) is readable by anyone who has its link, which the page's own code shows is possible. Restrict the sheet's sharing once the new backend is live, and serve any public list from an API route that returns only those four fields. (No such public route exists in this backend yet; it was out of scope.)
- The Supabase anon key is hard-coded in `src/integrations/supabase/client.ts`. That is normal for an anon key, but it is why the new tables enable RLS with no policies.

## Cut-over order

1. Deploy API to staging, run migrations, import legacy data (dry-run first).
2. Point a Netlify deploy preview at staging; submit synthetic registrations; confirm them in the admin API.
3. Deploy API to production; ship the frontend change; keep the Google Sheet untouched as a fallback until a few real registrations are verified.
