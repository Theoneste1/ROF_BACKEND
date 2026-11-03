/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAdmin, loginAs, makeApp, validPayload } from "./helpers.js";
import type { Db } from "../src/db.js";
import { DEFAULT_CLOSED_MESSAGE, registrationState } from "../src/registrationControl.js";

let app: FastifyInstance; let db: Db; let editionId: string;
let tok: Record<"viewer" | "admin" | "finance" | "super_admin", string>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const control = (t = tok.admin) => app.inject({ method: "GET", url: "/api/admin/registration-control", headers: auth(t) });
const change = (payload: unknown, t = tok.admin) =>
  app.inject({ method: "PATCH", url: "/api/admin/registration-control", payload: payload as any, headers: auth(t) });
const status = async () => (await app.inject({ method: "GET", url: "/api/registration-status" })).json();
let n = 0;
const submit = () => app.inject({ method: "POST", url: "/api/school-registrations", payload: validPayload({ school_code: `7${String(++n).padStart(4, "0")}` }) as any });

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

beforeEach(async () => {
  ({ app, db, editionId } = await makeApp());
  tok = {} as any;
  for (const role of ["viewer", "admin", "finance", "super_admin"] as const) {
    await createAdmin(db, role);
    tok[role] = await loginAs(app, `${role}@test.example`);
  }
});

describe("registrationState", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  const w = (open: boolean, opens: string | null = null, closes: string | null = null) =>
    registrationState({ registration_open: open, registration_opens_at: opens, registration_closes_at: closes }, now);
  it("closing always wins", () => {
    expect(w(false)).toBe("closed");
    expect(w(false, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")).toBe("closed");
  });
  it("follows the schedule while the switch is on", () => {
    expect(w(true)).toBe("open");
    expect(w(true, "2026-11-04T00:00:00Z")).toBe("scheduled");
    expect(w(true, "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z")).toBe("open");
    expect(w(true, null, "2026-11-03T10:00:00Z")).toBe("closed");
  });
});

describe("closing and opening", () => {
  it("Close stops submissions immediately, including direct API calls, with the custom message", async () => {
    expect((await submit()).statusCode).toBe(201);
    await change({ closed_message: "  We are closed for 2026.  " });
    const closed = await change({ action: "close" });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "closed", registration_open: false, total_registrations: 1, last_changed_by: "admin@test.example" });

    const res = await submit();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: "registration_closed", message: "We are closed for 2026." });
    expect(await status()).toMatchObject({ status: "closed", message: "We are closed for 2026.", opens_at: null, closes_at: null });

    // Even an incomplete direct API call is told registration is closed, not which fields are missing.
    const partial = await app.inject({ method: "POST", url: "/api/school-registrations", payload: { first_name: "x" } });
    expect(partial.statusCode).toBe(409);
    expect(partial.json().error.code).toBe("registration_closed");

    expect((await change({ action: "open" })).json().status).toBe("open");
    expect((await submit()).statusCode).toBe(201);
  });

  it("never touches existing registrations", async () => {
    await submit(); await submit();
    const before = (await db.query("SELECT * FROM school_registrations ORDER BY id")).rows;
    await change({ action: "close" });
    await change({ opens_at: inHours(1), closes_at: inHours(5), closed_message: "x" });
    await change({ action: "open" });
    expect((await db.query("SELECT * FROM school_registrations ORDER BY id")).rows).toEqual(before);
    expect((await control()).json().total_registrations).toBe(2);
  });

  it("falls back to the default message when none is set or it is cleared", async () => {
    await change({ action: "close" });
    expect((await status()).message).toBe(DEFAULT_CLOSED_MESSAGE);
    await change({ closed_message: "Custom" });
    await change({ closed_message: "   " });
    expect((await status()).message).toBe(DEFAULT_CLOSED_MESSAGE);
    expect((await control()).json().closed_message).toBeNull();
  });

  it("writes an audit entry for every change", async () => {
    await change({ action: "close" });
    await change({ closed_message: "Later" });
    const rows = (await db.query("SELECT actor_label, action, entity_id, changes FROM audit_log WHERE entity_type = 'competition_edition' ORDER BY id")).rows;
    expect(rows.map((r) => r.action)).toEqual(["registration.closed", "registration.settings_updated"]);
    expect(rows[0]).toMatchObject({ actor_label: "admin@test.example", entity_id: editionId });
    expect(rows[0]!.changes).toMatchObject({ before: { status: "open" }, after: { status: "closed" } });
  });

  it("does not count a message-only edit as a status change", async () => {
    await change({ action: "close" });
    const first = (await control()).json().last_changed_at;
    await change({ closed_message: "Only the text" }, tok.super_admin);
    expect((await control()).json()).toMatchObject({ last_changed_at: first, last_changed_by: "admin@test.example" });
  });
});

describe("schedules", () => {
  it("an opening time in the future arms the switch and shows Scheduled until then", async () => {
    await change({ action: "close" });
    const opens = inHours(2);
    const res = await change({ opens_at: opens });
    expect(res.json()).toMatchObject({ status: "scheduled", registration_open: true, opens_at: opens });
    expect(await status()).toMatchObject({ status: "scheduled", opens_at: opens });
    expect((await submit()).statusCode).toBe(409);
  });

  it("opens by itself once the opening time has passed", async () => {
    await change({ action: "close" });
    await db.query("UPDATE competition_editions SET registration_open = true, registration_opens_at = now() - interval '1 minute'");
    expect((await status()).status).toBe("open");
    expect((await submit()).statusCode).toBe(201);
  });

  it("closes by itself at the closing time", async () => {
    const closes = inHours(3);
    expect((await change({ closes_at: closes })).json()).toMatchObject({ status: "open", closes_at: closes });
    expect((await status()).closes_at).toBe(closes);
    await db.query("UPDATE competition_editions SET registration_closes_at = now() - interval '1 second'");
    expect((await status()).status).toBe("closed");
    expect((await submit()).statusCode).toBe(409);
  });

  it("Close wins over the schedule and keeps it; Open clears what would keep it closed", async () => {
    await change({ opens_at: inHours(-1), closes_at: inHours(4) });
    const closed = (await change({ action: "close" })).json();
    expect(closed).toMatchObject({ status: "closed", registration_open: false });
    expect(closed.opens_at).not.toBeNull();
    expect(closed.closes_at).not.toBeNull();

    // A passed closing time is cleared by Open; a future one is kept.
    await db.query("UPDATE competition_editions SET registration_opens_at = now() + interval '1 hour', registration_closes_at = now() + interval '2 hours'");
    const reopened = (await change({ action: "open" })).json();
    expect(reopened).toMatchObject({ status: "open", opens_at: null });
    expect(reopened.closes_at).not.toBeNull();
    await db.query("UPDATE competition_editions SET registration_opens_at = NULL, registration_closes_at = now() - interval '1 minute'");
    expect((await change({ action: "open" })).json()).toMatchObject({ status: "open", closes_at: null });
  });

  it("accepts a time with an offset and returns it in UTC", async () => {
    const res = await change({ closes_at: "2099-11-30T17:00:00+02:00" });
    expect(res.json().closes_at).toBe("2099-11-30T15:00:00.000Z");
  });
});

describe("validation", () => {
  it.each([
    [{}, "body"],
    [{ action: "pause" }, "action"],
    [{ opens_at: "2099-11-30T17:00" }, "opens_at"],
    [{ opens_at: "tomorrow" }, "opens_at"],
    [{ closes_at: "2000-01-01T00:00:00Z" }, "closes_at"],
    [{ opens_at: "2099-12-02T00:00:00Z", closes_at: "2099-12-01T00:00:00Z" }, "closes_at"],
    [{ closed_message: "x".repeat(1001) }, "closed_message"],
    [{ closed_message: 5 }, "closed_message"],
    [{ registration_open: true }, "registration_open"],
  ])("rejects %j", async (payload, field) => {
    const res = await change(payload);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toHaveProperty(field);
  });

  it("rejects a new opening time after the stored closing time", async () => {
    await change({ closes_at: inHours(2) });
    const res = await change({ opens_at: inHours(3) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toHaveProperty("closes_at");
  });
});

describe("permissions", () => {
  it("only admin and super_admin can change registration; every role can read it", async () => {
    for (const role of ["viewer", "finance"] as const) {
      expect((await change({ action: "close" }, tok[role])).statusCode).toBe(403);
      expect((await control(tok[role])).statusCode).toBe(200);
    }
    expect((await change({ action: "close" }, tok.super_admin)).statusCode).toBe(200);
    expect((await change({ action: "open" }, tok.admin)).statusCode).toBe(200);
  });

  it("requires sign-in for the admin endpoints but not for the public status", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/registration-control" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/registration-control", payload: { action: "close" } })).statusCode).toBe(401);
    const pub = await app.inject({ method: "GET", url: "/api/registration-status" });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(pub.json()).sort()).toEqual(["closes_at", "edition", "message", "opens_at", "status"]);
  });
});

describe("without a current edition", () => {
  it("reports closed publicly and 404 to administrators", async () => {
    await db.query("UPDATE competition_editions SET is_current = false");
    expect(await status()).toMatchObject({ status: "closed", message: DEFAULT_CLOSED_MESSAGE, edition: null });
    expect((await control()).statusCode).toBe(404);
    expect((await change({ action: "open" })).statusCode).toBe(404);
  });
});
