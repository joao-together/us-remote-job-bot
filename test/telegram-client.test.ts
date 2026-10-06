import { describe, expect, it } from "vitest";
import { TelegramClient, TelegramError } from "../src/core/telegram/client";
import { jobKeyboard } from "../src/core/telegram/format";

const TOKEN = "123456:SECRET-token_value";

interface Call {
  url: string;
  body: Record<string, unknown>;
  hasSignal: boolean;
}

function fakeFetcher(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      hasSignal: init?.signal instanceof AbortSignal,
    });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } });
const tooMany = (retryAfter: number) => ({
  status: 429,
  body: { ok: false, error_code: 429, description: "Too Many Requests: retry after " + retryAfter, parameters: { retry_after: retryAfter } },
});

function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("TelegramClient", () => {
  it("sends HTML with link previews disabled and returns the message id", async () => {
    const { fetcher, calls } = fakeFetcher([ok({ message_id: 99 })]);
    const client = new TelegramClient({ token: TOKEN, fetcher });

    const res = await client.sendMessage(555, "<b>hi</b>", jobKeyboard(1));

    expect(res).toEqual({ messageId: 99 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.hasSignal).toBe(true);
    expect(calls[0]!.body).toEqual({
      chat_id: 555,
      text: "<b>hi</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: jobKeyboard(1),
    });
  });

  it("omits reply_markup when none is given", async () => {
    const { fetcher, calls } = fakeFetcher([ok({ message_id: 1 })]);
    await new TelegramClient({ token: TOKEN, fetcher }).sendMessage(1, "x");
    expect(calls[0]!.body).not.toHaveProperty("reply_markup");
  });

  it("edits text and reply markup with the right bodies", async () => {
    const { fetcher, calls } = fakeFetcher([ok(true), ok(true)]);
    const client = new TelegramClient({ token: TOKEN, fetcher });

    await client.editMessageText(5, 10, "new", jobKeyboard(3, "applied"));
    await client.editMessageReplyMarkup(5, 10, jobKeyboard(3, "skipped"));

    expect(calls[0]!.url.endsWith("/editMessageText")).toBe(true);
    expect(calls[0]!.body).toEqual({
      chat_id: 5,
      message_id: 10,
      text: "new",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: jobKeyboard(3, "applied"),
    });
    expect(calls[1]!.url.endsWith("/editMessageReplyMarkup")).toBe(true);
    expect(calls[1]!.body).toEqual({ chat_id: 5, message_id: 10, reply_markup: jobKeyboard(3, "skipped") });
  });

  it("answers callback queries and sets the webhook", async () => {
    const { fetcher, calls } = fakeFetcher([ok(true), ok(true)]);
    const client = new TelegramClient({ token: TOKEN, fetcher });

    await client.answerCallbackQuery("cbq-1", "Marked applied");
    await client.setWebhook("https://bot.example/telegram/webhook", "shh");

    expect(calls[0]!.body).toEqual({ callback_query_id: "cbq-1", text: "Marked applied" });
    expect(calls[1]!.body).toEqual({
      url: "https://bot.example/telegram/webhook",
      secret_token: "shh",
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  });

  it("treats 'message is not modified' as success for edits", async () => {
    const notModified = {
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" },
    };
    const { fetcher } = fakeFetcher([notModified, notModified]);
    const client = new TelegramClient({ token: TOKEN, fetcher });

    await expect(client.editMessageReplyMarkup(1, 2, jobKeyboard(1))).resolves.toBeUndefined();
    await expect(client.editMessageText(1, 2, "same")).resolves.toBeUndefined();
  });

  it("still throws other 400 errors on edits", async () => {
    const { fetcher } = fakeFetcher([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } },
    ]);
    const client = new TelegramClient({ token: TOKEN, fetcher });
    await expect(client.editMessageText(1, 2, "x")).rejects.toMatchObject({ status: 400 });
  });

  it("honors retry_after on 429 when waitOn429 is true", async () => {
    const { fetcher, calls } = fakeFetcher([tooMany(3), ok({ message_id: 7 })]);
    const { waits, sleep } = sleeper();
    const client = new TelegramClient({ token: TOKEN, fetcher, sleep, waitOn429: true });

    await expect(client.sendMessage(1, "x")).resolves.toEqual({ messageId: 7 });
    expect(waits).toEqual([3000]);
    expect(calls).toHaveLength(2);
  });

  it("caps the 429 wait at 60s and gives up after 3 attempts", async () => {
    const { fetcher, calls } = fakeFetcher([tooMany(500), tooMany(500), tooMany(500)]);
    const { waits, sleep } = sleeper();
    const client = new TelegramClient({ token: TOKEN, fetcher, sleep, waitOn429: true });

    const err = await client.sendMessage(1, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).status).toBe(429);
    expect(waits).toEqual([60_000, 60_000]);
    expect(calls).toHaveLength(3);
  });

  it("surfaces retryAfter immediately when waitOn429 is false", async () => {
    const { fetcher, calls } = fakeFetcher([tooMany(12)]);
    const { waits, sleep } = sleeper();
    const client = new TelegramClient({ token: TOKEN, fetcher, sleep, waitOn429: false });

    const err = await client.sendMessage(1, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err).toMatchObject({ status: 429, retryAfter: 12 });
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("never puts the bot token in error messages", async () => {
    const { fetcher } = fakeFetcher([
      { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` } },
      new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`),
      { status: 502, body: "not json" },
    ]);
    const client = new TelegramClient({ token: TOKEN, fetcher });

    for (let i = 0; i < 3; i++) {
      const err = (await client.sendMessage(1, "x").catch((e: unknown) => e)) as TelegramError;
      expect(err).toBeInstanceOf(TelegramError);
      expect(err.message).not.toContain(TOKEN);
      expect(err.description).not.toContain(TOKEN);
      expect(String(err.stack)).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
    }
  });

  it("reports HTTP status for non-JSON error responses", async () => {
    const { fetcher } = fakeFetcher([{ status: 502, body: "oops" }]);
    const client = new TelegramClient({ token: TOKEN, fetcher });
    await expect(client.sendMessage(1, "x")).rejects.toMatchObject({ status: 502 });
  });
});
