import { DB_BATCH_SIZE } from "../config";
import type { DbDriver, Statement } from "./driver";

/** D1 rejects `undefined` and booleans; map them to SQL-friendly values. */
export function normalizeParams(params: unknown[] | undefined): unknown[] {
  return (params ?? []).map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Driver over a Worker D1 binding. Each chunk of a batch runs in one D1 transaction. */
export function bindingDriver(db: D1Database): DbDriver {
  const prepare = (stmt: Statement) => db.prepare(stmt.sql).bind(...normalizeParams(stmt.params));
  return {
    async query<T = Record<string, unknown>>(stmt: Statement): Promise<T[]> {
      const res = await prepare(stmt).all<T>();
      return res.results ?? [];
    },
    async batch(stmts: Statement[]): Promise<void> {
      for (const part of chunk(stmts, DB_BATCH_SIZE)) {
        await db.batch(part.map(prepare));
      }
    },
  };
}
