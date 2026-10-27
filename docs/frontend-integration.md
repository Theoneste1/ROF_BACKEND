# How the website uses the backend

The website (`olympiadProduction`, deployed by Netlify from the `develop` branch) talks to this API from the browser. There is no
Google Sheet or Apps Script in the registration flow.

API address: `https://rof-registration-api.onrender.com` (set `VITE_REGISTRATION_API_URL` to override).
The API only answers browsers on the origins listed in `CORS_ORIGINS` (Render environment variable). Add any new site address there,
for example a Netlify deploy-preview URL or `http://localhost:8080` for local testing, and remove it afterwards.

## Registration form (`/competitions/register`)

Code: `src/pages/CompetitionRegistration.tsx` and `src/utils/schoolRegistrationSubmit.ts`.

1. Province → District → Sector from `GET /api/locations`; Cell (optional) from `GET /api/locations/sectors/:sectorId/cells`.
2. Searchable school picker from `GET /api/schools?sector_id=…[&cell_id=…]`. Picking a school sends `directory_school_id` and the server
   fills the school name and code. **"My school is not listed"** lets the registrant type the name and code; a picked school that has no
   code on file asks for the code.
3. Submit with `POST /api/school-registrations` and an `Idempotency-Key` header (one key per distinct payload), so a retry after a
   flaky connection never creates a second registration. Server validation errors (`422`, `error.fields`) are shown next to the
   matching inputs; `409 registration_closed` and `429` get their own messages.
4. Head teacher first name, last name and phone are required, as is the head teacher's email.

### Field mapping (`FormState` → API)

| Form state | API field |
|---|---|
| `firstName`, `lastName` | `first_name`, `last_name` |
| `email`, `phone`, `role` | `email_address`, `phone_contact`, `school_role` |
| picked school / typed name and code | `directory_school_id` / `school_name`, `school_code` |
| `schoolType` | `school_type` |
| province, district, sector, cell (names looked up from the chosen ids) | `province`, `district`, `sector`, `cell` |
| `schoolBankName`, `schoolBankAccount` | `school_bank_name`, `school_bank_account` |
| `headTeacherFirstName`, `headTeacherLastName`, `headTeacherEmail`, `headTeacherPhone` | `head_teacher_first_name`, `head_teacher_last_name`, `head_teacher_email`, `head_teacher_phone` |
| `teacherFirstName`, `teacherLastName`, `teacherEmail`, `teacherPhone` | `mathematics_teacher_first_name`, `_last_name`, `_email`, `_phone` |
| `testEmail` | `test_delivery_email` |
| `teacherBankName`, `teacherBankAccount` | `teacher_bank_name`, `mathematics_teacher_account_number` |
| `primaryStudentCount`, `juniorStudentCount`, `seniorStudentCount` | `students_p5_p6`, `students_s1_s3`, `students_s4_s5` |
| `comments`, `additionalInfo` | `questions_comments_concerns_feedback`, `additional_information` |

## Registered Schools page (`/competitions/registered-schools`)

Code: `src/utils/registeredSchools.ts`. It reads `GET /api/registered-schools`: one row per school of the current edition with school
code, name, district and student count, and nothing else (no contacts, bank details, statuses or ids). Rejected and withdrawn
registrations are excluded; the response is never served from a stale cache, so a newly registered school shows up immediately. The page shows names exactly as registrants typed them, so an admin
should reject an abusive registration, which removes it from the list.

## Other pages

Results, summer-camp participants, certificates, the 2025 teacher list and the district statistics map still read a separate
"JRMC database" Google Sheet. That is outside the registration flow and has no database equivalent yet.
