import { describe, expect, it } from "vitest";
import { httpDriver } from "../src/core/store/driver-http";

const TOKEN = "secret-d1-api-token-xyz";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as typeof fetch;
  return { fetcher, calls };
}

const ok = (result: unknown[]) => () =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });

function makeDriver(fetcher: typeof fetch, sleeps: number[] = [], extra: object = {}) {
  return httpDriver({
    accountId: "acc",
    databaseId: "db",
    apiToken: TOKEN,
    fetcher,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
}

describe("httpDriver", () => {
  it("posts a single query with bearer auth and returns rows", async () => {
    const { fetcher, calls } = fakeFetch([ok([{ results: [{ n: 1 }], success: true, meta: {} }])]);
    const rows = await makeDriver(fetcher).query({ sql: "SELECT ? AS n", params: [1, undefined, true] });
    expect(rows).toEqual([{ n: 1 }]);
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sql: "SELECT ? AS n", params: [1, null, 1] });
  });

  it("retries a 429 then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetcher, calls } = fakeFetch([
      () => new Response("rate limited", { status: 429 }),
      ok([{ results: [{ ok: 1 }], success: true }]),
    ]);
    const rows = await makeDriver(fetcher, sleeps).query({ sql: "SELECT 1 AS ok" });
    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it("throws on a persistent 500 without leaking the token", async () => {
    const sleeps: number[] = [];
    const { fetcher, calls } = fakeFetch([() => new Response(`internal error for ${TOKEN}`, { status: 500 })]);
    const driver = makeDriver(fetcher, sleeps);
    const err = await driver.batch([{ sql: "INSERT INTO t VALUES (1)" }]).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("500");
    expect(err!.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("does not retry a 400 and surfaces API errors", async () => {
    const { fetcher, calls } = fakeFetch([
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: "syntax error" }] }), { status: 400 }),
    ]);
    await expect(makeDriver(fetcher).query({ sql: "SELEC" })).rejects.toThrow(/syntax error/);
    expect(calls).toHaveLength(1);
  });

  it("throws when a statement in a successful response failed", async () => {
    const { fetcher } = fakeFetch([ok([{ results: [], success: true }, { results: [], success: false }])]);
    await expect(makeDriver(fetcher).batch([{ sql: "A" }, { sql: "B" }])).rejects.toThrow();
  });

  it("sends batches as chunked batch requests", async () => {
    const { fetcher, calls } = fakeFetch([ok([])]);
    const stmts = Array.from({ length: 120 }, (_, i) => ({ sql: "INSERT INTO t VALUES (?)", params: [i] }));
    await makeDriver(fetcher).batch(stmts);
    expect(calls).toHaveLength(3);
    const first = JSON.parse(String(calls[0]!.init.body));
    expect(first.batch).toHaveLength(50);
    expect(first.batch[0]).toEqual({ sql: "INSERT INTO t VALUES (?)", params: [0] });
    expect(JSON.parse(String(calls[2]!.init.body)).batch).toHaveLength(20);
  });

  it("supports sequential batch mode", async () => {
    const { fetcher, calls } = fakeFetch([ok([{ results: [], success: true }])]);
    await makeDriver(fetcher, [], { batchMode: "sequential" }).batch([
      { sql: "A", params: [1] },
      { sql: "B" },
    ]);
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { sql: "A", params: [1] },
      { sql: "B", params: [] },
    ]);
  });

  it("passes a timeout signal and retries a timed-out request", async () => {
    const sleeps: number[] = [];
    const calls: Call[] = [];
    let n = 0;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (n++ === 0) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return ok([{ results: [{ ok: 1 }], success: true }])();
    }) as typeof fetch;
    const rows = await makeDriver(fetcher, sleeps).query({ sql: "SELECT 1 AS ok" });
    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(sleeps).toEqual([500]);
  });

  it("retries an aborted body read", async () => {
    const { fetcher, calls } = fakeFetch([
      () => {
        const res = new Response("{}", { status: 200 });
        Object.defineProperty(res, "text", { value: () => Promise.reject(new DOMException("aborted", "AbortError")) });
        return res;
      },
      ok([{ results: [{ ok: 1 }], success: true }]),
    ]);
    const rows = await makeDriver(fetcher).query({ sql: "SELECT 1 AS ok" });
    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it("throws a redacted error after persistent timeouts", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fetcher = (async () => {
      attempts++;
      throw new DOMException(`timed out calling with ${TOKEN}`, "AbortError");
    }) as typeof fetch;
    const err = await makeDriver(fetcher, sleeps)
      .query({ sql: "SELECT 1" })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/D1 HTTP query failed: network error/);
    expect(err!.message).not.toContain(TOKEN);
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });
});
