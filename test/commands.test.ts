import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AtsKind } from "../src/core/ats/types";
import { FAILING_AFTER_CONSECUTIVE } from "../src/core/config";
import { type NewJob, Store } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";
import type { InlineKeyboardMarkup } from "../src/core/telegram/format";
import { jobKeyboard } from "../src/core/telegram/format";
import { chunkLines, handleUpdate } from "../src/worker/commands";

const OWNER = 1001;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

let store: Store;
let tg: ReturnType<typeof fakeTelegram>;
let clock = T0;

function fakeTelegram() {
  const sent: { chatId: number | string; html: string }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const edits: { chatId: number | string; messageId: number; markup: InlineKeyboardMarkup }[] = [];
  return {
    sent,
    answers,
    edits,
    async sendMessage(chatId: number | string, html: string) {
      sent.push({ chatId, html });
      return { messageId: sent.length };
    },
    async answerCallbackQuery(id: string, text?: string) {
      answers.push({ id, text });
    },
    async editMessageReplyMarkup(chatId: number | string, messageId: number, markup: InlineKeyboardMarkup) {
      edits.push({ chatId, messageId, markup });
    },
  };
}

const deps = () => ({ store, telegram: tg, ownerId: String(OWNER), now: () => clock });

function message(text: string, opts: { from?: number; chatType?: string } = {}) {
  const from = opts.from ?? OWNER;
  return {
    update_id: 1,
    message: { message_id: 10, from: { id: from, is_bot: false }, chat: { id: from, type: opts.chatType ?? "private" }, text },
  };
}

function callback(data: string, opts: { from?: number; chatType?: string; messageId?: number } = {}) {
  const from = opts.from ?? OWNER;
  return {
    update_id: 2,
    callback_query: {
      id: "cb1",
      from: { id: from },
      data,
      message: { message_id: opts.messageId ?? 77, chat: { id: from, type: opts.chatType ?? "private" } },
    },
  };
}

async function send(text: string, opts?: { from?: number; chatType?: string }) {
  await handleUpdate(message(text, opts), deps());
  return tg.sent.at(-1)?.html ?? "";
}

async function addCompany(name: string, token: string, state: "active" | "pending_validation" = "active", ats: AtsKind = "lever") {
  return (await store.insertCompany({ name, ats, boardToken: token, state })).company;
}

function job(companyId: number, boardJobId: string, overrides: Partial<NewJob> = {}): NewJob {
  return {
    companyId,
    boardJobId,
    title: `Engineer ${boardJobId}`,
    normalizedTitle: `engineer ${boardJobId}`,
    locationText: "Remote - US",
    applyUrl: `https://jobs.lever.co/acme/${boardJobId}`,
    status: "pending",
    ...overrides,
  };
}

async function insertJob(companyId: number, boardJobId: string, overrides: Partial<NewJob> = {}): Promise<number> {
  await store.runBatch([store.stmtInsertJob(job(companyId, boardJobId, overrides), clock)]);
  const row = await env.DB.prepare("SELECT id FROM jobs WHERE company_id = ? AND board_job_id = ?").bind(companyId, boardJobId).first<{ id: number }>();
  return row!.id;
}

async function sentJob(companyId: number, boardJobId: string, overrides: Partial<NewJob> = {}): Promise<number> {
  const id = await insertJob(companyId, boardJobId, overrides);
  await store.markSent(id, 500 + id, clock);
  return id;
}

const statuses = async () =>
  (await env.DB.prepare("SELECT status FROM jobs ORDER BY id").all<{ status: string }>()).results.map((r) => r.status);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM companies"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  clock = T0;
  store = new Store(bindingDriver(env.DB), () => clock);
  tg = fakeTelegram();
});

describe("authorization", () => {
  it("ignores messages from other users", async () => {
    await send("/pause", { from: 2002 });
    expect(tg.sent).toEqual([]);
    expect((await store.getSettings()).paused).toBe(false);
  });

  it("ignores the owner in a group chat", async () => {
    await send("/add https://jobs.lever.co/acme", { chatType: "group" });
    expect(tg.sent).toEqual([]);
    expect(await store.listCompanies()).toEqual([]);
  });

  it("ignores callbacks from other users or group chats", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1");
    await handleUpdate(callback(`a:${id}`, { from: 2002 }), deps());
    await handleUpdate(callback(`a:${id}`, { chatType: "supergroup" }), deps());
    expect(tg.answers).toEqual([]);
    expect((await store.getJob(id))?.userAction).toBeNull();
  });

  it("ignores malformed updates", async () => {
    for (const u of [null, "x", 1, {}, { message: { text: "/help" } }, { callback_query: { id: 5 } }]) {
      await handleUpdate(u, deps());
    }
    expect(tg.sent).toEqual([]);
    expect(tg.answers).toEqual([]);
  });

  it("replies to the owner's private chat", async () => {
    await send("/help");
    expect(tg.sent[0]?.chatId).toBe(OWNER);
    expect(tg.sent[0]?.html).toContain("/add");
  });
});

describe("command parsing", () => {
  it("accepts /cmd@BotName", async () => {
    expect(await send("/help@JobAlertBot")).toContain("/exclude");
    await send("/pause@JobAlertBot");
    expect((await store.getSettings()).paused).toBe(true);
  });

  it("hints at /help for plain text and unknown commands", async () => {
    expect(await send("hello")).toContain("/help");
    expect(await send("/frobnicate")).toContain("/help");
  });
});

describe("/add", () => {
  it("stores a Lever URL as pending_validation and replies", async () => {
    const reply = await send("/add https://jobs.lever.co/acme");
    const [c] = await store.listCompanies();
    expect(c).toMatchObject({ ats: "lever", boardToken: "acme", state: "pending_validation" });
    expect(reply).toContain("acme will be checked within the hour");
  });

  it("rejects a path-traversal slug with an explanation", async () => {
    const reply = await send("/add foo/../bar");
    expect(reply).toMatch(/❌/);
    expect(await store.listCompanies({ includeInactive: true })).toEqual([]);
  });

  it("asks for a board link for a bare slug", async () => {
    const reply = await send("/add acme");
    expect(reply).toContain("https://jobs.lever.co/acme");
    expect(await store.listCompanies()).toEqual([]);
  });

  it("reports an existing company and re-checks an inactive one", async () => {
    const c = await addCompany("Acme", "acme");
    expect(await send("/add jobs.lever.co/acme")).toBe("Already watching Acme.");
    await store.setCompanyState(c.id, "inactive");
    expect(await send("/add https://jobs.lever.co/acme")).toContain("Re-checking Acme");
    expect((await store.getCompany(c.id))?.state).toBe("pending_validation");
  });

  it("explains usage without an argument", async () => {
    expect(await send("/add")).toContain("Usage");
  });
});

describe("/remove", () => {
  it("marks the company inactive", async () => {
    const c = await addCompany("Acme", "acme");
    expect(await send("/remove acme")).toContain("Stopped watching Acme");
    expect((await store.getCompany(c.id))?.state).toBe("inactive");
  });

  it("reports an unknown company", async () => {
    expect(await send("/remove nope")).toContain("Not watching");
  });

  it("asks to be specific when several companies match, then removes by ats:token", async () => {
    const a = await addCompany("Acme", "acme", "active", "lever");
    const b = await addCompany("Acme", "acme", "active", "greenhouse");
    const reply = await send("/remove Acme");
    expect(reply).toContain("lever:acme");
    expect(reply).toContain("greenhouse:acme");
    expect((await store.getCompany(a.id))?.state).toBe("active");

    await send("/remove greenhouse:acme");
    expect((await store.getCompany(b.id))?.state).toBe("inactive");
    expect((await store.getCompany(a.id))?.state).toBe("active");
  });
});

describe("/companies", () => {
  it("lists active companies with failing marked and pending separately, escaped", async () => {
    const f = await addCompany("Broken <Co>", "broken");
    await env.DB.prepare("UPDATE companies SET consecutive_failures = ? WHERE id = ?").bind(FAILING_AFTER_CONSECUTIVE, f.id).run();
    await addCompany("Acme", "acme");
    await addCompany("newco", "newco", "pending_validation");
    const reply = await send("/companies");
    expect(reply).toContain("Watching 2 companies");
    expect(reply).toContain("Broken &lt;Co&gt; ⚠️");
    expect(reply).toMatch(/Waiting for validation \(1\)[\s\S]*newco/);
  });

  it("splits long lists into messages under 4096 characters", async () => {
    for (let i = 0; i < 200; i++) await addCompany(`Company with a fairly long name number ${i}`, `co-${i}`);
    await send("/companies");
    expect(tg.sent.length).toBeGreaterThan(1);
    for (const m of tg.sent) expect(m.html.length).toBeLessThanOrEqual(4096);
    expect(tg.sent.map((m) => m.html).join("\n")).toContain("number 199");
  });

  it("chunkLines keeps every line", () => {
    expect(chunkLines(["aaa", "bbb", "ccc"], 7)).toEqual(["aaa\nbbb", "ccc"]);
  });
});

describe("/exclude", () => {
  it("adds a word once even if added twice", async () => {
    await send("/exclude add clearance");
    await send("/exclude add  Clearance ");
    const reply = await send("/exclude list");
    expect(reply.match(/clearance/g)).toHaveLength(1);
    expect((await store.getSettings()).excludedWords).toEqual(["clearance"]);
  });

  it("supports phrases and removal", async () => {
    await send("/exclude add security   clearance");
    await send("/exclude add on-call");
    expect(await send("/exclude remove security clearance")).not.toContain("security clearance");
    expect((await store.getSettings()).excludedWords).toEqual(["on-call"]);
  });

  it("rejects empty and overlong words", async () => {
    expect(await send("/exclude add")).toContain("Usage");
    expect(await send(`/exclude add ${"x".repeat(41)}`)).toContain("Usage");
    expect((await store.getSettings()).excludedWords).toEqual([]);
  });

  it("escapes words in the reply", async () => {
    expect(await send("/exclude add <b>")).toContain("&lt;b&gt;");
  });

  it("says when the list is empty", async () => {
    expect(await send("/exclude list")).toBe("No excluded words.");
  });
});

describe("/pause and /resume (AE5)", () => {
  it("suppresses pending jobs on pause and sends nothing old on resume", async () => {
    const c = await addCompany("Acme", "acme");
    await insertJob(c.id, "1");
    await insertJob(c.id, "2");
    expect(await send("/pause")).toContain("dropped");
    expect(await statuses()).toEqual(["suppressed", "suppressed"]);
    expect((await store.getSettings()).paused).toBe(true);

    tg.sent.length = 0;
    await send("/resume");
    expect(tg.sent).toHaveLength(1);
    expect((await store.getSettings()).paused).toBe(false);
    expect(await statuses()).toEqual(["suppressed", "suppressed"]);
    expect(await store.listPending()).toEqual([]);
  });
});

describe("/status", () => {
  it("replies with the status summary", async () => {
    expect(await send("/status")).toContain("<b>Status</b>");
  });
});

describe("/applied", () => {
  it("replies with a friendly message when empty", async () => {
    expect(await send("/applied")).toContain("haven't marked any jobs");
  });

  it("lists applied jobs newest first with escaped fields", async () => {
    const c = await addCompany("Acme & Co", "acme");
    const a = await sentJob(c.id, "1", { title: "Dev <1>" });
    const b = await sentJob(c.id, "2", { title: "Dev 2" });
    await store.setUserAction(a, "applied", T0);
    await store.setUserAction(b, "applied", T0 + 86_400_000);
    const reply = await send("/applied");
    expect(reply).toContain("1. Dev 2 — Acme &amp; Co (2026-10-07)\nhttps://jobs.lever.co/acme/2");
    expect(reply).toContain("2. Dev &lt;1&gt; — Acme &amp; Co (2026-10-06)");
  });
});

describe("buttons", () => {
  it("records applied, switches to skipped, and a double tap is idempotent", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1");

    await handleUpdate(callback(`a:${id}`), deps());
    expect(tg.answers.at(-1)?.text).toBe("Marked applied");
    expect(tg.edits.at(-1)).toEqual({ chatId: OWNER, messageId: 77, markup: jobKeyboard(id, "applied") });
    expect(await store.getJob(id)).toMatchObject({ userAction: "applied", actionAt: T0 });

    clock = T0 + 1000;
    await handleUpdate(callback(`a:${id}`), deps());
    expect(await store.getJob(id)).toMatchObject({ userAction: "applied", actionAt: T0 });
    expect(tg.edits.at(-1)?.markup).toEqual(jobKeyboard(id, "applied"));

    clock = T0 + 2000;
    await handleUpdate(callback(`s:${id}`), deps());
    expect(tg.answers.at(-1)?.text).toBe("Marked skipped");
    expect(tg.edits.at(-1)?.markup).toEqual(jobKeyboard(id, "skipped"));
    expect(await store.getJob(id)).toMatchObject({ userAction: "skipped", actionAt: T0 + 2000 });
  });

  it("answers unknown buttons", async () => {
    for (const data of ["x:1", "a:../1", "a:0", ""]) await handleUpdate(callback(data), deps());
    expect(tg.answers.map((a) => a.text)).toEqual(["Unknown button", "Unknown button", "Unknown button", "Unknown button"]);
    expect(tg.edits).toEqual([]);
  });

  it("refuses jobs that were never sent", async () => {
    const c = await addCompany("Acme", "acme");
    const pending = await insertJob(c.id, "1");
    await handleUpdate(callback(`a:${pending}`), deps());
    await handleUpdate(callback("a:999999"), deps());
    expect(tg.answers.map((a) => a.text)).toEqual(["This job can't be updated", "This job can't be updated"]);
    expect(tg.edits).toEqual([]);
  });
});
