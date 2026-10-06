/** A parameterized SQL statement. */
export interface Statement {
  sql: string;
  params?: unknown[];
}

/**
 * Minimal database surface shared by the Worker (D1 binding) and the
 * GitHub Actions poller (D1 HTTP API).
 */
export interface DbDriver {
  /** Run one read or write statement and return its rows. */
  query<T = Record<string, unknown>>(stmt: Statement): Promise<T[]>;
  /** Run several write statements atomically, in order. */
  batch(stmts: Statement[]): Promise<void>;
}
