import type { Queryable } from "./db.js";

export interface Actor { id: string | null; label: string; ip?: string }

/** Append-only audit entry. `changes` must never contain bank account values. */
export async function writeAudit(
  db: Queryable, actor: Actor, action: string, entityType: string, entityId: string | null,
  changes?: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, entity_type, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id, actor.label, action, entityType, entityId, changes === undefined ? null : JSON.stringify(changes), actor.ip ?? null],
  );
}
