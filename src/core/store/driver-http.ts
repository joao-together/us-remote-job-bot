import { DB_BATCH_SIZE } from "../config";
import type { DbDriver, Statement } from "./driver";
import { chunk, normalizeParams } from "./driver-binding";
import { errorMessage, redactSecrets, sleep as defaultSleep } from "../util";

export interface HttpDriverOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * "batch" (default) sends each chunk as one `{ batch: [...] }` request, run by D1 as one transaction.
   * "sequential" sends one request per statement, for accounts where the batch body is unavailable.
   */
  batchMode?: "batch" | "sequential";
  maxAttempts?: number;
  baseDelayMs?: number;
}

interface D1QueryResult {
  results?: unknown[];
  success?: boolean;
}

interface D1Response {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: D1QueryResult[];
}

class RetryableError extends Error {}

/** Driver over the Cloudflare D1 HTTP API, used by the GitHub Actions poller. */
export function httpDriver(opts: HttpDriverOptions): DbDriver {
  const fetcher = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}` +
    `/d1/database/${encodeURIComponent(opts.databaseId)}/query`;

  async function attempt(body: unknown): Promise<D1QueryResult[]> {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new RetryableError(`network error: ${errorMessage(err)}`);
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let parsed: D1Response;
    try {
      parsed = JSON.parse(text) as D1Response;
    } catch {
      throw new Error(`HTTP ${res.status}: unparseable response: ${text.slice(0, 300)}`);
    }
    if (!res.ok || !parsed.success) {
      const errors = (parsed.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
      throw new Error(`HTTP ${res.status}: ${errors || "request failed"}`);
    }
    const results = parsed.result ?? [];
    if (results.some((r) => r.success === false)) throw new Error("a statement in the request failed");
    return results;
  }

  async function post(body: unknown): Promise<D1QueryResult[]> {
    let lastError: Error = new Error("no attempts made");
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        return await attempt(body);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!(err instanceof RetryableError) || i === maxAttempts) break;
        await sleep(baseDelayMs * 2 ** (i - 1));
      }
    }
    throw new Error(redactSecrets(`D1 HTTP query failed: ${lastError.message}`, opts.apiToken));
  }

  const toBody = (stmt: Statement) => ({ sql: stmt.sql, params: normalizeParams(stmt.params) });

  return {
    async query<T = Record<string, unknown>>(stmt: Statement): Promise<T[]> {
      const results = await post(toBody(stmt));
      return (results[0]?.results ?? []) as T[];
    },
    async batch(stmts: Statement[]): Promise<void> {
      if (opts.batchMode === "sequential") {
        for (const stmt of stmts) await post(toBody(stmt));
        return;
      }
      for (const part of chunk(stmts, DB_BATCH_SIZE)) {
        await post({ batch: part.map(toBody) });
      }
    },
  };
}
