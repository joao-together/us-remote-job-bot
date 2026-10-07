import { describe, expect, it, vi } from "vitest";
import { dispatchPoll } from "../src/worker/dispatch";

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
