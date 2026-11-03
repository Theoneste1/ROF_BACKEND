/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Catalogue of the fields an administrator may pick for a custom export. Every value comes from one joined
 * registration row (see JOINS in registrations.ts): the registering contact, the mathematics teacher, the head
 * teacher and the school's location all live on the registration or its location tables.
 *
 * Keys are the only thing a client sends; anything not in this list is rejected, and `sensitive` fields need
 * the bank:read permission. Field keys are part of the API: the admin portal stores them in saved templates.
 */
import { can, type Role } from "./auth.js";

export type ExportCategory =
  | "registration" | "contact" | "teacher" | "teacher_bank" | "school" | "school_bank" | "head_teacher" | "students" | "notes";

export interface ExportField {
  key: string;
  label: string;
  category: ExportCategory;
  /** Bank details: only roles with bank:read may export them, and such exports are audited as sensitive. */
  sensitive?: boolean;
  /** Digit strings (codes, phones, accounts) that spreadsheets must keep as text. */
  text?: boolean;
  value: (row: Record<string, any>) => unknown;
}

export const EXPORT_CATEGORIES: { key: ExportCategory; label: string }[] = [
  { key: "registration", label: "Registration" },
  { key: "teacher", label: "Mathematics Teacher" },
  { key: "teacher_bank", label: "Teacher Banking Information" },
  { key: "school", label: "School Information" },
  { key: "school_bank", label: "School Banking Information" },
  { key: "head_teacher", label: "Headteacher Information" },
  { key: "contact", label: "Registering Contact" },
  { key: "students", label: "Student Estimates" },
  { key: "notes", label: "Notes" },
];

const fullName = (first: unknown, last: unknown) => [first, last].filter((v) => v).join(" ") || null;
const col = (name: string) => (r: Record<string, any>) => r[name];

export const EXPORT_FIELDS: ExportField[] = [
  { key: "registration_reference", label: "Registration Reference", category: "registration", value: col("registration_reference") },
  { key: "edition_name", label: "Competition Edition", category: "registration", value: col("edition_name") },
  { key: "status", label: "Status", category: "registration", value: col("status") },
  { key: "status_note", label: "Status Note", category: "registration", value: col("status_note") },
  { key: "created_at", label: "Submitted At", category: "registration", value: col("created_at") },
  { key: "has_bank_details", label: "Has Bank Details", category: "registration", value: (r) => (r.school_bank_name || r.school_bank_account || r.teacher_bank_name || r.mathematics_teacher_account_number ? "Yes" : "No") },

  { key: "mathematics_teacher_full_name", label: "Teacher Full Name", category: "teacher", value: (r) => fullName(r.mathematics_teacher_first_name, r.mathematics_teacher_last_name) },
  { key: "mathematics_teacher_first_name", label: "Teacher First Name", category: "teacher", value: col("mathematics_teacher_first_name") },
  { key: "mathematics_teacher_last_name", label: "Teacher Last Name", category: "teacher", value: col("mathematics_teacher_last_name") },
  { key: "mathematics_teacher_email", label: "Teacher Email", category: "teacher", value: col("mathematics_teacher_email") },
  { key: "mathematics_teacher_phone", label: "Teacher Phone", category: "teacher", text: true, value: col("mathematics_teacher_phone") },
  { key: "test_delivery_email", label: "Email To Send The Test To", category: "teacher", value: col("test_delivery_email") },

  { key: "teacher_bank_name", label: "Teacher Bank Name", category: "teacher_bank", sensitive: true, value: col("teacher_bank_name") },
  { key: "mathematics_teacher_account_number", label: "Teacher Bank Account Number", category: "teacher_bank", sensitive: true, text: true, value: col("mathematics_teacher_account_number") },

  { key: "school_name", label: "School Name", category: "school", value: col("school_name") },
  { key: "school_code", label: "School Code", category: "school", text: true, value: col("school_code") },
  { key: "school_type", label: "School Type", category: "school", value: col("school_type") },
  { key: "province", label: "Province", category: "school", value: col("province") },
  { key: "district", label: "District", category: "school", value: col("district") },
  { key: "sector", label: "Sector", category: "school", value: col("sector") },
  { key: "cell", label: "Cell", category: "school", value: col("cell") },
  { key: "school_address", label: "School Address", category: "school", value: (r) => [r.cell, r.sector, r.district, r.province].filter((v) => v).join(", ") || null },

  { key: "school_bank_name", label: "School Bank Name", category: "school_bank", sensitive: true, value: col("school_bank_name") },
  { key: "school_bank_account", label: "School Bank Account Number", category: "school_bank", sensitive: true, text: true, value: col("school_bank_account") },

  { key: "head_teacher_full_name", label: "Headteacher Full Name", category: "head_teacher", value: (r) => fullName(r.head_teacher_first_name, r.head_teacher_last_name) },
  { key: "head_teacher_first_name", label: "Headteacher First Name", category: "head_teacher", value: col("head_teacher_first_name") },
  { key: "head_teacher_last_name", label: "Headteacher Last Name", category: "head_teacher", value: col("head_teacher_last_name") },
  { key: "head_teacher_email", label: "Headteacher Email", category: "head_teacher", value: col("head_teacher_email") },
  { key: "head_teacher_phone", label: "Headteacher Phone", category: "head_teacher", text: true, value: col("head_teacher_phone") },

  { key: "contact_full_name", label: "Contact Full Name", category: "contact", value: (r) => fullName(r.first_name, r.last_name) },
  { key: "first_name", label: "Contact First Name", category: "contact", value: col("first_name") },
  { key: "last_name", label: "Contact Last Name", category: "contact", value: col("last_name") },
  { key: "email_address", label: "Contact Email", category: "contact", value: col("email_address") },
  { key: "phone_contact", label: "Contact Phone", category: "contact", text: true, value: col("phone_contact") },
  { key: "school_role", label: "Contact Position/Role", category: "contact", value: col("school_role") },

  { key: "students_p5_p6", label: "Students P5-P6", category: "students", value: col("students_p5_p6") },
  { key: "students_s1_s3", label: "Students S1-S3", category: "students", value: col("students_s1_s3") },
  { key: "students_s4_s5", label: "Students S4-S5", category: "students", value: col("students_s4_s5") },
  { key: "total_estimated_students", label: "Total Estimated Students", category: "students", value: col("total_estimated_students") },

  { key: "questions_comments_concerns_feedback", label: "Questions/Comments/Concerns", category: "notes", value: col("questions_comments_concerns_feedback") },
  { key: "additional_information", label: "Additional Information", category: "notes", value: col("additional_information") },
];

const BY_KEY = new Map(EXPORT_FIELDS.map((f) => [f.key, f]));
export const MAX_EXPORT_FIELDS = EXPORT_FIELDS.length;

export const canExportField = (role: Role, f: ExportField): boolean => !f.sensitive || can(role, "bank:read");

/** The catalogue as the given role may see it, grouped by category. */
export function exportCatalogue(role: Role) {
  return EXPORT_CATEGORIES
    .map((c) => ({
      key: c.key, label: c.label,
      fields: EXPORT_FIELDS.filter((f) => f.category === c.key && canExportField(role, f))
        .map((f) => ({ key: f.key, label: f.label, sensitive: f.sensitive === true })),
    }))
    .filter((c) => c.fields.length > 0);
}

/**
 * Validates a client's field list: a non-empty array of known, distinct keys, in the order the columns should appear.
 * Unknown keys are a validation error; sensitive keys the role may not read are a permission error.
 */
export function resolveExportFields(raw: unknown, role: Role):
  { ok: true; fields: ExportField[] } | { ok: false; status: 403 | 422; message: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EXPORT_FIELDS || !raw.every((k) => typeof k === "string"))
    return { ok: false, status: 422, message: `fields must be a list of 1 to ${MAX_EXPORT_FIELDS} field keys.` };
  if (new Set(raw).size !== raw.length) return { ok: false, status: 422, message: "fields must not repeat a field." };
  const unknown = raw.filter((k) => !BY_KEY.has(k));
  if (unknown.length) return { ok: false, status: 422, message: `Unknown field(s): ${unknown.slice(0, 5).join(", ")}.` };
  const fields = raw.map((k) => BY_KEY.get(k)!);
  if (fields.some((f) => !canExportField(role, f)))
    return { ok: false, status: 403, message: "You do not have permission to export bank details." };
  return { ok: true, fields };
}
