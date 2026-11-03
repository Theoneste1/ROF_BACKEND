/**
 * Registration control: whether the current edition accepts public registrations right now, and the Admin Portal's
 * changes to that (open, close, automatic opening/closing times, the message shown while closed).
 * The state is worked out on every request from the stored switch and times, so no background job is needed.
 */
import type { Db, Queryable } from "./db.js";
import { ApiError, validationError } from "./errors.js";
import { writeAudit, type Actor } from "./audit.js";

export type RegistrationState = "open" | "closed" | "scheduled";

export const DEFAULT_CLOSED_MESSAGE =
  "Registration is currently closed. Thank you for your interest in the Rwanda Olympiad Competition. Please check our website for future announcements.";
export const MAX_CLOSED_MESSAGE_LENGTH = 1000;

type Time = Date | string | null;
interface RegistrationWindow { registration_open: boolean; registration_opens_at: Time; registration_closes_at: Time }
interface EditionRow extends RegistrationWindow {
  id: string; name: string; year: number;
  registration_closed_message: string | null;
  registration_status_changed_at: Time;
}

const EDITION_COLUMNS = `e.id, e.name, e.year, e.registration_open, e.registration_opens_at, e.registration_closes_at,
  e.registration_closed_message, e.registration_status_changed_at`;

const toDate = (v: Time): Date | null => (v == null ? null : new Date(v));
const iso = (v: Time): string | null => toDate(v)?.toISOString() ?? null;
const sameTime = (a: Time, b: Time) => iso(a) === iso(b);

/**
 * The one rule for whether registration is open, shared by the submit route and both status endpoints.
 * Closing always wins: while the switch is off, the scheduled times are kept but have no effect.
 */
export function registrationState(w: RegistrationWindow, now = new Date()): RegistrationState {
  if (!w.registration_open) return "closed";
  const closes = toDate(w.registration_closes_at);
  if (closes && now >= closes) return "closed";
  const opens = toDate(w.registration_opens_at);
  if (opens && now < opens) return "scheduled";
  return "open";
}

const closedMessage = (ed: EditionRow | undefined) => ed?.registration_closed_message ?? DEFAULT_CLOSED_MESSAGE;

const currentEdition = async (db: Queryable, forUpdate = false): Promise<EditionRow | undefined> =>
  (await db.query<EditionRow>(`SELECT ${EDITION_COLUMNS} FROM competition_editions e WHERE e.is_current${forUpdate ? " FOR UPDATE" : ""}`)).rows[0];

/** The current edition, or 409 registration_closed (carrying the administrator's message) when it is not open right now. */
export async function requireOpenEdition(db: Queryable): Promise<{ id: string; year: number; name: string }> {
  const ed = await currentEdition(db);
  if (!ed || registrationState(ed) !== "open") throw new ApiError(409, "registration_closed", closedMessage(ed));
  return ed;
}

/** What the public registration page needs: no personal data, no administrator details. */
export async function publicRegistrationStatus(db: Queryable) {
  const ed = await currentEdition(db);
  if (!ed) return { status: "closed" as RegistrationState, opens_at: null, closes_at: null, message: DEFAULT_CLOSED_MESSAGE, edition: null };
  const status = registrationState(ed);
  return {
    status,
    // A closed registration has no meaningful times: the switch is off or the closing time has passed.
    opens_at: status === "scheduled" ? iso(ed.registration_opens_at) : null,
    closes_at: status === "closed" ? null : iso(ed.registration_closes_at),
    message: closedMessage(ed),
    edition: { name: ed.name, year: ed.year },
  };
}

/** The Admin Portal's view: the stored settings, the resulting status, the number of registrations and the last change. */
export async function registrationControl(db: Queryable) {
  const ed = (await db.query<EditionRow & { total_registrations: number; changed_by_email: string | null }>(
    `SELECT ${EDITION_COLUMNS}, u.email AS changed_by_email,
       (SELECT count(*)::int FROM school_registrations r WHERE r.competition_edition_id = e.id) AS total_registrations
     FROM competition_editions e LEFT JOIN admin_users u ON u.id = e.registration_status_changed_by
     WHERE e.is_current`)).rows[0];
  if (!ed) throw new ApiError(404, "no_current_edition", "No competition edition is currently configured.");
  return {
    edition: { id: ed.id, name: ed.name, year: ed.year },
    status: registrationState(ed),
    registration_open: ed.registration_open,
    opens_at: iso(ed.registration_opens_at),
    closes_at: iso(ed.registration_closes_at),
    closed_message: ed.registration_closed_message,
    default_closed_message: DEFAULT_CLOSED_MESSAGE,
    total_registrations: ed.total_registrations,
    last_changed_at: iso(ed.registration_status_changed_at),
    last_changed_by: ed.changed_by_email,
  };
}

export interface RegistrationControlChange {
  action?: "open" | "close";
  opens_at?: Date | null;
  closes_at?: Date | null;
  closed_message?: string | null;
}

const CHANGE_FIELDS = ["action", "opens_at", "closes_at", "closed_message"];
// An explicit offset is required: without one the time would be read in the server's zone, not the administrator's.
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function validateRegistrationControlChange(body: unknown, now = new Date()): RegistrationControlChange {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw validationError({ body: "Expected a JSON object." });
  const b = body as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const out: RegistrationControlChange = {};

  for (const k of Object.keys(b)) if (!CHANGE_FIELDS.includes(k)) errors[k] = "Unknown field.";
  if (!CHANGE_FIELDS.some((k) => k in b)) errors.body = "Nothing to change.";

  if (b.action !== undefined) {
    if (b.action === "open" || b.action === "close") out.action = b.action;
    else errors.action = 'action must be "open" or "close".';
  }
  for (const k of ["opens_at", "closes_at"] as const) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v === null || v === "") out[k] = null;
    else if (typeof v === "string" && DATE_TIME_RE.test(v) && !Number.isNaN(Date.parse(v))) out[k] = new Date(v);
    else errors[k] = `${k} must be a date-time with a time zone (for example 2026-11-30T17:00:00+02:00), or null.`;
  }
  if (out.closes_at && out.closes_at <= now) errors.closes_at = "The closing time must be in the future.";
  if (out.opens_at && out.closes_at && out.closes_at <= out.opens_at) errors.closes_at = "The closing time must be after the opening time.";

  if ("closed_message" in b) {
    const v = b.closed_message;
    if (v === null) out.closed_message = null;
    else if (typeof v !== "string") errors.closed_message = "The message must be text.";
    else if (v.trim().length > MAX_CLOSED_MESSAGE_LENGTH) errors.closed_message = `The message must be at most ${MAX_CLOSED_MESSAGE_LENGTH} characters.`;
    else out.closed_message = v.trim() || null; // empty: fall back to the default message
  }

  if (Object.keys(errors).length) throw validationError(errors);
  return out;
}

/**
 * Applies a change to the current edition. Times and the message are applied first, then the action:
 * - setting an opening time arms the switch, so registration opens by itself at that time;
 * - "open" turns the switch on and clears anything that would keep registration closed now
 *   (the opening time, and a closing time that has passed);
 * - "close" turns the switch off and keeps the times, which have no effect until registration is opened again.
 */
export async function changeRegistrationControl(db: Db, change: RegistrationControlChange, actor: Actor, now = new Date()) {
  await db.transaction(async (tx) => {
    const ed = await currentEdition(tx, true);
    if (!ed) throw new ApiError(404, "no_current_edition", "No competition edition is currently configured.");

    const next = {
      registration_open: ed.registration_open,
      registration_opens_at: toDate(ed.registration_opens_at),
      registration_closes_at: toDate(ed.registration_closes_at),
      registration_closed_message: ed.registration_closed_message,
    };
    if (change.opens_at !== undefined) {
      next.registration_opens_at = change.opens_at;
      if (change.opens_at) next.registration_open = true;
    }
    if (change.closes_at !== undefined) next.registration_closes_at = change.closes_at;
    if (change.closed_message !== undefined) next.registration_closed_message = change.closed_message;
    if (change.action === "open") {
      next.registration_open = true;
      next.registration_opens_at = null;
      if (next.registration_closes_at && next.registration_closes_at <= now) next.registration_closes_at = null;
    }
    if (change.action === "close") next.registration_open = false;

    if (next.registration_opens_at && next.registration_closes_at && next.registration_closes_at <= next.registration_opens_at)
      throw validationError({ closes_at: "The closing time must be after the opening time." });

    // A change to the switch or the times is a status change; editing only the message is not.
    const statusChanged = change.action !== undefined || next.registration_open !== ed.registration_open ||
      !sameTime(next.registration_opens_at, ed.registration_opens_at) || !sameTime(next.registration_closes_at, ed.registration_closes_at);

    await tx.query(
      `UPDATE competition_editions SET registration_open = $2, registration_opens_at = $3, registration_closes_at = $4,
         registration_closed_message = $5,
         registration_status_changed_at = CASE WHEN $6::boolean THEN now() ELSE registration_status_changed_at END,
         registration_status_changed_by = CASE WHEN $6::boolean THEN $7::uuid ELSE registration_status_changed_by END
       WHERE id = $1`,
      [ed.id, next.registration_open, iso(next.registration_opens_at), iso(next.registration_closes_at),
        next.registration_closed_message, statusChanged, actor.id]);

    const summary = (w: typeof next | EditionRow) => ({
      status: registrationState(w, now),
      registration_open: w.registration_open,
      opens_at: iso(w.registration_opens_at),
      closes_at: iso(w.registration_closes_at),
      closed_message: w.registration_closed_message,
    });
    const action = change.action === "open" ? "registration.opened" : change.action === "close" ? "registration.closed" : "registration.settings_updated";
    await writeAudit(tx, actor, action, "competition_edition", ed.id, { before: summary(ed), after: summary(next) });
  });
  return registrationControl(db);
}
