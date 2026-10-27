import { describe, expect, it } from "vitest";
import { normalizePhone, validateRegistration, validateRegistrationPatch, FIELD_SPECS } from "../src/validation.js";
import { validPayload } from "./helpers.js";

const errorsFor = (over: Record<string, unknown>) => {
  const r = validateRegistration(validPayload(over));
  return r.ok ? {} : r.errors;
};

describe("registration validation", () => {
  it("accepts a complete valid payload and normalizes it", () => {
    const r = validateRegistration(validPayload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.email_address).toBe("aline.uwase@example.org");
    expect(r.data.phone_contact).toBe("+250788123456");
    expect(r.data.students_s1_s3).toBe(20);
    expect(r.data.school_code).toBe("012345"); // leading zero preserved
    expect(r.data.school_bank_account).toBe("0001234567890");
  });

  it.each(FIELD_SPECS.filter((s) => s.required).map((s) => s.key))("requires %s", (key) => {
    const payload = validPayload();
    delete payload[key];
    const errs = (validateRegistration(payload) as { errors: Record<string, string> }).errors;
    expect(errs[key]).toMatch(/required/i);
    expect(errs[key]).toBeDefined();
    // blank string and whitespace are also "missing"
    expect(errorsFor({ [key]: "   " })[key]).toMatch(/required/i);
  });

  it("treats optional fields as optional and stores null", () => {
    const optional = ["school_bank_name", "school_bank_account", "teacher_bank_name", "mathematics_teacher_account_number",
      "questions_comments_concerns_feedback", "additional_information"];
    const payload = validPayload();
    for (const k of optional) delete payload[k];
    const r = validateRegistration(payload);
    expect(r.ok).toBe(true);
    if (r.ok) for (const k of optional) expect(r.data[k as keyof typeof r.data]).toBeNull();
  });

  it("trims and collapses whitespace", () => {
    const r = validateRegistration(validPayload({ school_name: "  Groupe   Scolaire \t Test  " }));
    expect(r.ok && r.data.school_name).toBe("Groupe Scolaire Test");
  });

  it.each(["not-an-email", "a@b", "a b@example.org", "@example.org", "a@@example.org", "a..b@example.org", "a@example..org"])("rejects bad email %s", (v) => {
    expect(errorsFor({ email_address: v }).email_address).toBeDefined();
    expect(errorsFor({ head_teacher_email: v }).head_teacher_email).toBeDefined();
    expect(errorsFor({ test_delivery_email: v }).test_delivery_email).toBeDefined();
  });

  it("allows test_delivery_email to equal mathematics_teacher_email and teachers to share emails", () => {
    const r = validateRegistration(validPayload({ test_delivery_email: "claire@example.org", head_teacher_email: "claire@example.org" }));
    expect(r.ok).toBe(true);
  });

  describe("phones", () => {
    it.each([
      ["0788123456", "+250788123456"], ["078 812 3456", "+250788123456"], ["+250788123456", "+250788123456"],
      ["250788123456", "+250788123456"], ["0722000111", "+250722000111"], ["0791234567", "+250791234567"],
      ["0252123456", "+250252123456"], // Rwanda landline (02x)
      ["0152123456", null], // 10 digits but not a Rwanda mobile/landline prefix
      ["0221234567", "+250221234567"], ["+14155552671", "+14155552671"], ["+256772123456", "+256772123456"],
    ])("normalizes %s", (input, expected) => expect(normalizePhone(input)).toBe(expected));

    it.each(["12345", "0788", "abcdefghij", "0688123456", "07881234567", "+0788123456", "078812345a", "+250 68 812 3456"])("rejects %s", (v) => {
      expect(normalizePhone(v)).toBeNull();
      expect(errorsFor({ phone_contact: v }).phone_contact).toBeDefined();
    });
  });

  describe("student counts", () => {
    it("accepts zero (number and string) and totals are not accepted from the client", () => {
      const r = validateRegistration(validPayload({ students_p5_p6: 0, students_s1_s3: "0", students_s4_s5: 0, total_estimated_students: 9999 }));
      expect(r.ok).toBe(true);
      expect(r.ok && "total_estimated_students" in r.data).toBe(false);
    });
    it.each([-1, "-1", 1.5, "1.5", "abc", "1e3", " ", NaN, null, true, [], {}, 100001, "1,000"])("rejects %j", (v) => {
      for (const f of ["students_p5_p6", "students_s1_s3", "students_s4_s5"]) expect(errorsFor({ [f]: v })[f]).toBeDefined();
    });
  });

  it("validates enums against the form's actual options", () => {
    expect(errorsFor({ school_role: "Janitor" }).school_role).toBeDefined();
    expect(errorsFor({ school_type: "Charter" }).school_type).toBeDefined();
    for (const role of ["Teacher", "Head Teacher", "Deputy Head Teacher", "Director of Studies", "Other"]) expect(errorsFor({ school_role: role }).school_role).toBeUndefined();
    for (const t of ["Public", "Government Aided", "Private"]) expect(errorsFor({ school_type: t }).school_type).toBeUndefined();
  });

  it("applies the form's code/bank rules (digits only; bank name has no digits)", () => {
    expect(errorsFor({ school_code: "AB12" }).school_code).toBeDefined();
    expect(errorsFor({ school_code: "1".repeat(21) }).school_code).toBeDefined();
    expect(errorsFor({ school_bank_account: "12ab34" }).school_bank_account).toBeDefined();
    expect(errorsFor({ school_bank_account: "123" }).school_bank_account).toBeDefined();
    expect(errorsFor({ school_bank_name: "Bank 1" }).school_bank_name).toBeDefined();
    expect(errorsFor({ teacher_bank_name: "Bank 1" }).teacher_bank_name).toBeDefined();
  });

  it("enforces maximum lengths and rejects control characters", () => {
    expect(errorsFor({ first_name: "A".repeat(81) }).first_name).toBeDefined();
    expect(errorsFor({ additional_information: "x".repeat(5001) }).additional_information).toBeDefined();
    expect(errorsFor({ school_name: "x".repeat(201) }).school_name).toBeDefined();
    expect(errorsFor({ additional_information: "bad\u0000byte" }).additional_information).toBeDefined();
    expect(errorsFor({ additional_information: "x".repeat(5000) }).additional_information).toBeUndefined();
  });

  it("accepts unicode names and rejects names with digits or markup", () => {
    expect(errorsFor({ first_name: "Zoë-Marie" }).first_name).toBeUndefined();
    expect(errorsFor({ last_name: "O'Brien Jr." }).last_name).toBeUndefined();
    expect(errorsFor({ first_name: "<script>" }).first_name).toBeDefined();
    expect(errorsFor({ first_name: "Bob123" }).first_name).toBeDefined();
  });

  it("rejects non-text where text is expected and non-object bodies", () => {
    expect(errorsFor({ school_name: 123 }).school_name).toBeDefined();
    expect(errorsFor({ school_name: { a: 1 } }).school_name).toBeDefined();
    for (const body of [null, "x", 5, [], undefined]) expect(validateRegistration(body).ok).toBe(false);
  });

  it("ignores attempts to set system fields", () => {
    const r = validateRegistration(validPayload({ status: "approved", id: "x", registration_reference: "FAKE", competition_edition_id: "y", created_at: "2000-01-01" }));
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.data)).not.toContain("status");
  });

  it("returns every error at once, field by field", () => {
    const r = validateRegistration({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).length).toBe(FIELD_SPECS.filter((s) => s.required).length);
  });
});

describe("registration patch validation", () => {
  it("validates only supplied fields and normalizes", () => {
    const r = validateRegistrationPatch({ phone_contact: "0788000000", students_p5_p6: "5" });
    expect(r).toEqual({ ok: true, data: { phone_contact: "+250788000000", students_p5_p6: 5 } });
  });
  it("rejects unknown/system fields, empty patches and blank required fields", () => {
    expect(validateRegistrationPatch({ status: "approved" }).ok).toBe(false);
    expect(validateRegistrationPatch({ total_estimated_students: 5 }).ok).toBe(false);
    expect(validateRegistrationPatch({}).ok).toBe(false);
    expect(validateRegistrationPatch({ first_name: "" }).ok).toBe(false);
    expect(validateRegistrationPatch({ school_bank_account: "" })).toEqual({ ok: true, data: { school_bank_account: null } });
  });
});
