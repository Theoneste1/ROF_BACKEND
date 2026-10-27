import pg from "pg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface QueryResult<T = Record<string, any>> { rows: T[]; rowCount: number }
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Executes a multi-statement SQL script (no parameters). */
  exec(sql: string): Promise<void>;
}
export interface Db extends Queryable {
  /** Runs fn inside a single transaction; rolls back if fn throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string, opts: { ssl?: boolean; max?: number; ca?: string; rejectUnauthorized?: boolean } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: opts.rejectUnauthorized ?? true, ...(opts.ca ? { ca: opts.ca } : {}) } : undefined,
    statement_timeout: 15000,
  });
  return {
    async query(text, params) {
      const r = await pool.query(text, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          async query(text, params) {
            const r = await client.query(text, params as unknown[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
          async exec(sql) { await client.query(sql); },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) { await pool.query(sql); },
    close: () => pool.end(),
  };
}

export const isUniqueViolation = (err: unknown, constraintHint?: string): boolean => {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== "23505") return false;
  return constraintHint ? `${e.constraint ?? ""} ${e.message ?? ""}`.includes(constraintHint) : true;
};
