import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchPoll,
  dispatchWorkflow,
  EXPAND_CRON,
  EXPAND_WORKFLOW,
  POLL_CRON,
  POLL_WORKFLOW,
  WATCHDOG_CRON,
} from "../src/worker/dispatch";
import worker from "../src/worker/index";

function recorder(status: number, body = "") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("dispatchPoll", () => {
  it("posts a workflow_dispatch for main with the token", async () => {
    const r = recorder(204);
    const ok = await dispatchPoll({ token: "ghtok", repo: "me/bot" }, r.fetcher);
    expect(ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe("https://api.github.com/repos/me/bot/actions/workflows/poll.yml/dispatches");
    const headers = r.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghtok");
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({ ref: "main" });
  });

  it("skips without calling GitHub when unconfigured", async () => {
    const r = recorder(204);
    expect(await dispatchPoll({ repo: "me/bot" }, r.fetcher)).toBe(false);
    expect(await dispatchPoll({ token: "ghtok" }, r.fetcher)).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it("returns false and never logs the token when GitHub rejects", async () => {
    const r = recorder(401, '{"message":"Bad credentials ghtok"}');
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPoll({ token: "ghtok", repo: "me/bot" }, r.fetcher)).toBe(false);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("401");
    expect(logged).not.toContain("ghtok");
    spy.mockRestore();
  });

  it("returns false on network errors without throwing", async () => {
    const fetcher = (async () => {
      throw new Error("connect failed");
    }) as unknown as typeof fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPoll({ token: "ghtok", repo: "me/bot" }, fetcher)).toBe(false);
    spy.mockRestore();
  });
});

describe("dispatchWorkflow", () => {
  it("dispatches the poll and expand workflows by file name", async () => {
    const r = recorder(204);
    expect(await dispatchWorkflow({ token: "ghtok", repo: "me/bot" }, POLL_WORKFLOW, r.fetcher)).toBe(true);
    expect(await dispatchWorkflow({ token: "ghtok", repo: "me/bot" }, EXPAND_WORKFLOW, r.fetcher)).toBe(true);
    expect(r.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/me/bot/actions/workflows/poll.yml/dispatches",
      "https://api.github.com/repos/me/bot/actions/workflows/expand-companies.yml/dispatches",
    ]);
    for (const call of r.calls) {
      expect(call.init.method).toBe("POST");
      expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer ghtok");
      expect(JSON.parse(call.init.body as string)).toEqual({ ref: "main" });
    }
  });

  it("names the workflow when GitHub rejects, without the token", async () => {
    const r = recorder(404, '{"message":"Not Found ghtok"}');
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchWorkflow({ token: "ghtok", repo: "me/bot" }, EXPAND_WORKFLOW, r.fetcher)).toBe(false);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("expand-companies.yml");
    expect(logged).toContain("404");
    expect(logged).not.toContain("ghtok");
    spy.mockRestore();
  });
});

describe("scheduled()", () => {
  const T = Date.UTC(2026, 9, 12, 6, 0, 0);
  let urls: string[];

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deliveries"),
      env.DB.prepare("DELETE FROM jobs"),
      env.DB.prepare("DELETE FROM companies"),
      env.DB.prepare("DELETE FROM settings"),
    ]);
    urls = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 204 });
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (cron: string) =>
    worker.scheduled(
      { cron, scheduledTime: T, noRetry() {} } as ScheduledController,
      { ...env, GITHUB_DISPATCH_TOKEN: "ghtok", GITHUB_REPO: "me/bot" },
    );

  it("uses the poll, watchdog and weekly expansion crons (keep in sync with wrangler.toml)", () => {
    expect([POLL_CRON, WATCHDOG_CRON, EXPAND_CRON]).toEqual(["*/10 * * * *", "43 * * * *", "0 6 * * 1"]);
  });

  it("starts the poller on the 10-minute cron", async () => {
    await run(POLL_CRON);
    expect(urls).toEqual(["https://api.github.com/repos/me/bot/actions/workflows/poll.yml/dispatches"]);
  });

  it("starts the expansion workflow on the weekly cron", async () => {
    await run(EXPAND_CRON);
    expect(urls).toEqual(["https://api.github.com/repos/me/bot/actions/workflows/expand-companies.yml/dispatches"]);
  });

  it("runs the watchdog on the hourly cron, never dispatching a workflow", async () => {
    // An active company and a poll that never succeeded: the watchdog warns via Telegram.
    await env.DB.prepare(
      "INSERT INTO companies (name, ats, board_token, state, baselined, created_at) VALUES ('A', 'lever', 'a', 'active', 1, 0)",
    ).run();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_poll_start_at', ?)").bind(JSON.stringify(T - 5 * 3600_000)).run();
    await run(WATCHDOG_CRON);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/);
  });
});
