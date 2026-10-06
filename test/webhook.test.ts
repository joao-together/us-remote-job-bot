import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/worker/env";
import worker, { SECRET_HEADER, WEBHOOK_PATH, secretsMatch } from "../src/worker/index";

const URL_BASE = "https://bot.example";
const SECRET = "test-webhook-secret";
const OWNER = 1001;

let telegramCalls: { method: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM companies"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  telegramCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = url.split("/").at(-1) ?? "";
    telegramCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: unknown, opts: { secret?: string | null; path?: string; method?: string; raw?: boolean } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.secret !== null) headers.set(SECRET_HEADER, opts.secret ?? SECRET);
  return new Request(`${URL_BASE}${opts.path ?? WEBHOOK_PATH}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "GET" ? undefined : opts.raw ? String(body) : JSON.stringify(body),
  });
}

const textUpdate = (text: string, from = OWNER, chatType = "private") => ({
  update_id: 1,
  message: { message_id: 1, from: { id: from }, chat: { id: from, type: chatType }, text },
});

const companyCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM companies").first<{ n: number }>())!.n;

describe("webhook auth", () => {
  it("returns 404 for other paths and methods", async () => {
    expect((await worker.fetch(post(textUpdate("/help"), { path: "/" }), env)).status).toBe(404);
    expect((await worker.fetch(post(null, { method: "GET" }), env)).status).toBe(404);
  });

  it("rejects every request with 401 when the secret or owner id is unset", async () => {
    const configs: WorkerEnv[] = [
      { ...env, TELEGRAM_WEBHOOK_SECRET: "" },
      { ...env, OWNER_USER_ID: "" },
      { ...env, TELEGRAM_WEBHOOK_SECRET: undefined as unknown as string },
    ];
    for (const e of configs) {
      expect((await worker.fetch(post(textUpdate("/add https://jobs.lever.co/acme")), e)).status).toBe(401);
      expect((await worker.fetch(post(textUpdate("/help"), { secret: "" }), e)).status).toBe(401);
    }
    expect(await companyCount()).toBe(0);
    expect(telegramCalls).toEqual([]);
  });

  it("rejects a wrong or missing secret header and changes nothing", async () => {
    for (const secret of [null, "", "wrong", `${SECRET}x`, SECRET.slice(0, -1)]) {
      const res = await worker.fetch(post(textUpdate("/add https://jobs.lever.co/acme"), { secret }), env);
      expect(res.status).toBe(401);
    }
    expect(await companyCount()).toBe(0);
    expect(telegramCalls).toEqual([]);
  });

  it("ignores non-owners and group chats with 200", async () => {
    expect((await worker.fetch(post(textUpdate("/add https://jobs.lever.co/acme", 2002)), env)).status).toBe(200);
    expect((await worker.fetch(post(textUpdate("/add https://jobs.lever.co/acme", OWNER, "group")), env)).status).toBe(200);
    expect(await companyCount()).toBe(0);
    expect(telegramCalls).toEqual([]);
  });

  it("returns 200 for invalid JSON", async () => {
    const res = await worker.fetch(post("{not json", { raw: true }), env);
    expect(res.status).toBe(200);
    expect(telegramCalls).toEqual([]);
  });

  it("compares secrets exactly", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abd", "abc")).toBe(false);
    expect(secretsMatch("abcabc", "abc")).toBe(false);
    expect(secretsMatch("", "abc")).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
  });
});

describe("webhook dispatch", () => {
  it("handles an owner command and replies through Telegram", async () => {
    const res = await worker.fetch(post(textUpdate("/add https://jobs.lever.co/acme")), env);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT ats, board_token, state FROM companies").first();
    expect(row).toEqual({ ats: "lever", board_token: "acme", state: "pending_validation" });
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: OWNER, parse_mode: "HTML" } });
    expect(String(telegramCalls[0]!.body.text)).toContain("within the hour");
  });

  it("still returns 200 when Telegram fails", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ ok: false, error_code: 500, description: "boom" }, { status: 500 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await worker.fetch(post(textUpdate("/help")), env);
    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("500 boom"));
    expect(error.mock.calls.flat().join(" ")).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});
