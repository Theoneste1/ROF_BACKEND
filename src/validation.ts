/**
 * Server-side validation + normalization of registration payloads.
 * Never trusts the client: unknown keys (id, status, totals, ...) are ignored,
 * every required field is checked, and errors are reported per field.
 */

export const SCHOOL_ROLES = ["Teacher", "Head Teacher", "Deputy Head Teacher", "Director of Studies", "Other"] as const;
export const SCHOOL_TYPES = ["Public", "Government Aided", "Private"] as const;
export const REGISTRATION_STATUSES = ["pending", "under_review", "verified", "approved", "rejected", "withdrawn"] as const;

export type FieldErrors = Record<string, string>;

export interface ValidatedRegistration {
  first_name: string;
  last_name: string;
  email_address: string;
  phone_contact: string;
  school_role: string;
  school_name: string;
  school_code: string;
  school_type: string;
  province: string;
  district: string;
  sector: string;
  /** Optional; validated against the sector when given. */
  cell: string | null;
  /** Set when the user picked their school from the directory; name/code are then taken from it. */
  directory_school_id: string | null;
  school_bank_name: string | null;
  school_bank_account: string | null;
  head_teacher_first_name: string;
  head_teacher_last_name: string;
  head_teacher_email: string;
  head_teacher_phone: string;
  mathematics_teacher_first_name: string;
  mathematics_teacher_last_name: string;
  mathematics_teacher_email: string;
  mathematics_teacher_phone: string;
  test_delivery_email: string;
  teacher_bank_name: string | null;
  mathematics_teacher_account_number: string | null;
  students_p5_p6: number;
  students_s1_s3: number;
  students_s4_s5: number;
  questions_comments_concerns_feedback: string | null;
  additional_information: string | null;
}

type Kind = "name" | "text" | "email" | "phone" | "enum" | "schoolCode" | "bankAccount" | "bankName" | "count" | "freeText";
interface FieldSpec {
  key: keyof ValidatedRegistration;
  label: string;
  kind: Kind;
  required: boolean;
  max?: number;
  options?: readonly string[];
}

export const FIELD_SPECS: FieldSpec[] = [
  { key: "first_name", label: "First name", kind: "name", required: true, max: 80 },
  { key: "last_name", label: "Last name", kind: "name", required: true, max: 80 },
  { key: "email_address", label: "Email address", kind: "email", required: true },
  { key: "phone_contact", label: "Phone contact", kind: "phone", required: true },
  { key: "school_role", label: "Role at school", kind: "enum", required: true, options: SCHOOL_ROLES },
  { key: "school_name", label: "School name", kind: "text", required: true, max: 200 },
  { key: "school_code", label: "School code", kind: "schoolCode", required: true },
  { key: "school_type", label: "School type", kind: "enum", required: true, options: SCHOOL_TYPES },
  { key: "province", label: "School province", kind: "text", required: true, max: 60 },
  { key: "district", label: "School district", kind: "text", required: true, max: 60 },
  { key: "sector", label: "School sector", kind: "text", required: true, max: 60 },
  { key: "cell", label: "School cell", kind: "text", required: false, max: 60 },
  { key: "school_bank_name", label: "School bank name", kind: "bankName", required: false, max: 100 },
  { key: "school_bank_account", label: "School bank account", kind: "bankAccount", required: false },
  { key: "head_teacher_first_name", label: "Headteacher's first name", kind: "name", required: true, max: 80 },
  { key: "head_teacher_last_name", label: "Headteacher's last name", kind: "name", required: true, max: 80 },
  { key: "head_teacher_email", label: "Headteacher's email address", kind: "email", required: true },
  { key: "head_teacher_phone", label: "Headteacher's phone contact", kind: "phone", required: true },
  { key: "mathematics_teacher_first_name", label: "Mathematics teacher's first name", kind: "name", required: true, max: 80 },
  { key: "mathematics_teacher_last_name", label: "Mathematics teacher's last name", kind: "name", required: true, max: 80 },
  { key: "mathematics_teacher_email", label: "Mathematics teacher's email address", kind: "email", required: true },
  { key: "mathematics_teacher_phone", label: "Mathematics teacher's phone contact", kind: "phone", required: true },
  { key: "test_delivery_email", label: "Email to send the test to", kind: "email", required: true },
  { key: "teacher_bank_name", label: "Teacher's bank name", kind: "bankName", required: false, max: 100 },
  { key: "mathematics_teacher_account_number", label: "Mathematics teacher's account number", kind: "bankAccount", required: false },
  { key: "students_p5_p6", label: "Students from P5 to P6", kind: "count", required: true },
  { key: "students_s1_s3", label: "Students from S1 to S3", kind: "count", required: true },
  { key: "students_s4_s5", label: "Students from S4 to S5", kind: "count", required: true },
  { key: "questions_comments_concerns_feedback", label: "Question/comment/concern/feedback", kind: "freeText", required: false, max: 5000 },
  { key: "additional_information", label: "Additional information", kind: "freeText", required: false, max: 5000 },
];

export const MAX_STUDENTS_PER_GROUP = 100000;

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Same rule as the live form: school codes are digits only; text, so leading zeros survive.
const SCHOOL_CODE_RE = /^\d{1,20}$/;
const BANK_ACCOUNT_RE = /^\d{4,34}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Normalizes a phone number to a canonical text form.
 *  - Rwanda mobile  07[2389]XXXXXXX  / 2507...  / +2507...  -> +2507XXXXXXXX
 *  - Rwanda landline 02XXXXXXXX      / 2502...  / +2502...  -> +2502XXXXXXXX
 *  - other international: + followed by 8-15 digits (E.164), no leading 0 after +.
 * Returns null if the number is not acceptable.
 */
export function normalizePhone(raw: string): string | null {
  const stripped = raw.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(stripped)) return null;
  let national: string | null = null;
  if (/^0\d{9}$/.test(stripped)) national = stripped.slice(1);
  else if (/^\+?250\d{9}$/.test(stripped)) national = stripped.replace(/^\+?250/, "");
  if (national !== null) {
    return /^(7[2389]\d{7}|2\d{8})$/.test(national) ? `+250${national}` : null;
  }
  if (/^\+[1-9]\d{7,14}$/.test(stripped)) return stripped;
  return null;
}

function validateOne(spec: FieldSpec, input: unknown): { value?: string | number | null; error?: string } {
  const { label } = spec;
  if (input === undefined || input === null || (typeof input === "string" && input.trim() === "")) {
    return spec.required ? { error: `${label} is required.` } : { value: null };
  }

  if (spec.kind === "count") {
    let n: number;
    if (typeof input === "number") n = input;
    else if (typeof input === "string" && /^\d+$/.test(input.trim())) n = Number(input.trim());
    else return { error: `${label} must be a whole number (0 or more).` };
    if (!Number.isInteger(n) || n < 0) return { error: `${label} must be a whole number (0 or more).` };
    if (n > MAX_STUDENTS_PER_GROUP) return { error: `${label} must not exceed ${MAX_STUDENTS_PER_GROUP}.` };
    return { value: n };
  }

  if (typeof input !== "string") return { error: `${label} must be text.` };
  if (CONTROL_CHARS_RE.test(input)) return { error: `${label} contains invalid characters.` };
  // Free text keeps its line breaks; everything else is single-line.
  const value = spec.kind === "freeText" ? input.replace(/\r\n/g, "\n").trim() : collapse(input);
  if (spec.max && value.length > spec.max) return { error: `${label} must be at most ${spec.max} characters.` };

  switch (spec.kind) {
    case "name":
      if (!NAME_RE.test(value)) return { error: `${label} may only contain letters, spaces, apostrophes, dots and hyphens.` };
      return { value };
    case "email": {
      const email = value.toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email) || email.includes("..")) return { error: `${label} must be a valid email address.` };
      return { value: email };
    }
    case "phone": {
      const phone = normalizePhone(value);
      if (!phone) return { error: `${label} must be a valid phone number (e.g. 0788123456 or +250788123456).` };
      return { value: phone };
    }
    case "enum":
      if (!spec.options!.includes(value)) return { error: `${label} must be one of: ${spec.options!.join(", ")}.` };
      return { value };
    case "schoolCode":
      if (!SCHOOL_CODE_RE.test(value)) return { error: `${label} must contain digits only (up to 20).` };
      return { value };
    case "bankAccount": {
      const compact = value.replace(/[\s-]/g, "");
      if (!BANK_ACCOUNT_RE.test(compact)) return { error: `${label} must contain 4 to 34 digits only.` };
      return { value: compact };
    }
    case "bankName":
      if (/\d/.test(value)) return { error: `${label} cannot contain numbers.` };
      return { value };
    default:
      return { value };
  }
}

/** Validates a full registration submission. */
export function validateRegistration(body: unknown): { ok: true; data: ValidatedRegistration } | { ok: false; errors: FieldErrors } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: { _body: "Request body must be a JSON object." } };
  }
  const src = body as Record<string, unknown>;
  const errors: FieldErrors = {};
  const out: Record<string, unknown> = {};

  // A school picked from the directory supplies its own name (and usually its code).
  let directoryId: string | null = null;
  const rawDir = src.directory_school_id;
  if (rawDir !== undefined && rawDir !== null && !(typeof rawDir === "string" && rawDir.trim() === "")) {
    if (typeof rawDir === "string" && UUID_RE.test(rawDir.trim())) directoryId = rawDir.trim().toLowerCase();
    else errors.directory_school_id = "School selection is invalid.";
  }
  out.directory_school_id = directoryId;

  for (const spec of FIELD_SPECS) {
    const fromDirectory = directoryId !== null && (spec.key === "school_name" || spec.key === "school_code");
    const res = validateOne(fromDirectory ? { ...spec, required: false } : spec, src[spec.key]);
    if (res.error) errors[spec.key] = res.error;
    else out[spec.key] = res.value ?? (fromDirectory ? "" : null);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: out as unknown as ValidatedRegistration };
}

/** Validates only the supplied subset of fields (admin PATCH). Unknown keys are rejected. */
export function validateRegistrationPatch(body: unknown): { ok: true; data: Partial<ValidatedRegistration> } | { ok: false; errors: FieldErrors } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: { _body: "Request body must be a JSON object." } };
  }
  const src = body as Record<string, unknown>;
  const errors: FieldErrors = {};
  const out: Record<string, unknown> = {};
  const known = new Set<string>(FIELD_SPECS.map((s) => s.key));
  for (const key of Object.keys(src)) {
    if (!known.has(key)) errors[key] = "This field cannot be updated.";
  }
  for (const spec of FIELD_SPECS) {
    if (!(spec.key in src)) continue;
    const res = validateOne(spec, src[spec.key]);
    if (res.error) errors[spec.key] = res.error;
    else out[spec.key] = res.value ?? null;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (Object.keys(out).length === 0) return { ok: false, errors: { _body: "No updatable fields supplied." } };
  return { ok: true, data: out as Partial<ValidatedRegistration> };
}

export const BANK_FIELDS = ["school_bank_name", "school_bank_account", "teacher_bank_name", "mathematics_teacher_account_number"] as const;
export const LOCATION_FIELDS = ["province", "district", "sector", "cell"] as const;
