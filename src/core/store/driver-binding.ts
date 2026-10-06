import { DB_BATCH_SIZE } from "../config";
import { chunk, normalizeParams } from "../util";
import type { DbDriver, Statement } from "./driver";

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
