import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AtsKind } from "../src/core/ats/types";
import { FAILING_AFTER_CONSECUTIVE } from "../src/core/config";
import { type NewJob, Store } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";
import { TelegramError } from "../src/core/telegram/client";
import type { InlineKeyboardMarkup } from "../src/core/telegram/format";
import { jobKeyboard } from "../src/core/telegram/format";
import { chunkLines, handleUpdate, parseUserId, WELCOME_TEXT } from "../src/worker/commands";

const OWNER = 1001;
const MEMBER = 3003;
const STRANGER = 2002;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

let store: Store;
let tg: ReturnType<typeof fakeTelegram>;
let clock = T0;

function fakeTelegram() {
  const sent: { chatId: number | string; html: string }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const edits: { chatId: number | string; messageId: number; markup: InlineKeyboardMarkup }[] = [];
  /** Sends to these chat ids (as strings) throw the given error. */
  const failFor = new Map<string, Error>();
  return {
    sent,
    answers,
    edits,
    failFor,
    async sendMessage(chatId: number | string, html: string) {
      const err = failFor.get(String(chatId));
      if (err) throw err;
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

interface MessageOpts {
  from?: number;
  chatType?: string;
  firstName?: string;
  username?: string;
}

function message(text: string, opts: MessageOpts = {}) {
  const from = opts.from ?? OWNER;
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: from, is_bot: false, first_name: opts.firstName ?? "Pat", ...(opts.username && { username: opts.username }) },
      chat: { id: from, type: opts.chatType ?? "private" },
      text,
    },
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

async function send(text: string, opts?: MessageOpts) {
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

const ownerAction = async (jobId: number) => (await store.getDelivery(jobId, String(OWNER)))?.userAction ?? null;

const statuses = async () =>
  (await env.DB.prepare("SELECT status FROM jobs ORDER BY id").all<{ status: string }>()).results.map((r) => r.status);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM access_requests"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM companies"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  clock = T0;
  store = new Store(bindingDriver(env.DB), () => clock);
  tg = fakeTelegram();
});

describe("authorization", () => {
  it("does not run commands for unknown users", async () => {
    await send("/pause", { from: STRANGER });
    await send("/invite 2002", { from: STRANGER });
    expect((await store.getSettings()).paused).toBe(false);
    expect(await store.listUsers()).toEqual([]);
    expect(tg.sent.every((m) => !m.html.includes("Paused"))).toBe(true);
  });

  it("ignores the owner in a group chat", async () => {
    await send("/add https://jobs.lever.co/acme", { chatType: "group" });
    expect(tg.sent).toEqual([]);
    expect(await store.listCompanies()).toEqual([]);
  });

  it("ignores callbacks from unknown or revoked users and from group chats", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1");
    await store.inviteUser(String(MEMBER));
    await store.revokeUser(String(MEMBER));
    await handleUpdate(callback(`a:${id}`, { from: STRANGER }), deps());
    await handleUpdate(callback(`a:${id}`, { from: MEMBER }), deps());
    await handleUpdate(callback(`a:${id}`, { chatType: "supergroup" }), deps());
    expect(tg.answers).toEqual([]);
    expect(tg.sent).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first("n")).toBe(0);
  });

  it("ignores a member in a group chat", async () => {
    await store.inviteUser(String(MEMBER));
    await send("/help", { from: MEMBER, chatType: "group" });
    await send("/help", { from: STRANGER, chatType: "group" });
    expect(tg.sent).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM access_requests").first("n")).toBe(0);
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

  it("lists fast-tier companies by name and only counts wide-tier ones", async () => {
    await addCompany("Fasty", "fasty");
    const w = await addCompany("Widey", "widey");
    await env.DB.prepare("UPDATE companies SET tier = 'wide' WHERE id = ?").bind(w.id).run();
    const reply = await send("/companies");
    expect(reply).toContain("Watching 2 companies");
    expect(reply).toContain("1 checked every 10 minutes (listed below), 1 more checked hourly.");
    expect(reply).toContain("Fasty");
    expect(reply).not.toContain("Widey");
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
    await send("/exclude add On-Call");
    expect((await store.getSettings()).excludedWords).toEqual(["security clearance", "on call"]);
    expect(await send("/exclude remove Security-Clearance")).not.toContain("security clearance");
    expect((await store.getSettings()).excludedWords).toEqual(["on call"]);
  });

  it("rejects empty and overlong words", async () => {
    expect(await send("/exclude add")).toContain("Usage");
    expect(await send(`/exclude add ${"x".repeat(41)}`)).toContain("Usage");
    expect(await send("/exclude add <>")).toContain("Usage");
    expect((await store.getSettings()).excludedWords).toEqual([]);
  });

  it("stores the canonical tokens, so markup never reaches the reply", async () => {
    const reply = await send("/exclude add <b>C#</b>");
    expect(reply).toContain("• b c# b");
    expect(reply).not.toContain("<b>C#");
    expect((await store.getSettings()).excludedWords).toEqual(["b c# b"]);
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
    await store.setDeliveryAction(a, String(OWNER), "applied", T0);
    await store.setDeliveryAction(b, String(OWNER), "applied", T0 + 86_400_000);
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
    expect(await store.getDelivery(id, String(OWNER))).toMatchObject({ userAction: "applied", actionAt: T0 });

    clock = T0 + 1000;
    await handleUpdate(callback(`a:${id}`), deps());
    expect(await store.getDelivery(id, String(OWNER))).toMatchObject({ userAction: "applied", actionAt: T0 });
    expect(tg.edits.at(-1)?.markup).toEqual(jobKeyboard(id, "applied"));

    clock = T0 + 2000;
    await handleUpdate(callback(`s:${id}`), deps());
    expect(tg.answers.at(-1)?.text).toBe("Marked skipped");
    expect(tg.edits.at(-1)?.markup).toEqual(jobKeyboard(id, "skipped"));
    expect(await store.getDelivery(id, String(OWNER))).toMatchObject({ userAction: "skipped", actionAt: T0 + 2000 });
    expect(await ownerAction(id)).toBe("skipped");
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

describe("members", () => {
  beforeEach(async () => {
    await store.inviteUser(String(MEMBER));
  });

  it("shows members their own help and the owner the full one", async () => {
    const memberHelp = await send("/start", { from: MEMBER });
    expect(tg.sent.at(-1)?.chatId).toBe(MEMBER);
    expect(memberHelp).toContain("/applied");
    expect(memberHelp).toContain("/status");
    expect(memberHelp).not.toContain("/add");
    expect(memberHelp).not.toContain("/invite");
    expect(await send("/help", { from: MEMBER })).toBe(memberHelp);

    const ownerHelp = await send("/help");
    for (const cmd of ["/add", "/invite", "/revoke", "/users", "/pause"]) expect(ownerHelp).toContain(cmd);
  });

  it("rejects every owner-only command from a member without side effects", async () => {
    const cmds = [
      "/add https://jobs.lever.co/acme",
      "/remove acme",
      "/companies",
      "/exclude add clearance",
      "/exclude list",
      "/pause",
      "/resume",
      "/invite 4004",
      "/revoke 3003",
      "/users",
      "/PAUSE@JobAlertBot",
    ];
    for (const cmd of cmds) expect(await send(cmd, { from: MEMBER })).toBe("Only the owner can do that.");
    expect(tg.sent.every((m) => m.chatId === MEMBER)).toBe(true);
    expect(await store.getSettings()).toMatchObject({ paused: false, excludedWords: [] });
    expect(await store.listCompanies({ includeInactive: true })).toEqual([]);
    expect((await store.listUsers()).map((u) => u.userId)).toEqual([String(MEMBER)]);
  });

  it("gives members /status without the user count, and the owner with it", async () => {
    const memberStatus = await send("/status", { from: MEMBER });
    expect(memberStatus).toContain("<b>Status</b>");
    expect(memberStatus).not.toContain("Invited users");
    expect(await send("/status")).toContain("Invited users: 1");
  });

  it("hints at /help for a member's plain text and unknown commands", async () => {
    expect(await send("hi", { from: MEMBER })).toContain("/help");
    expect(await send("/frobnicate", { from: MEMBER })).toContain("Unknown command");
  });

  it("keeps Applied/Skip and /applied separate per user", async () => {
    const c = await addCompany("Acme", "acme");
    const a = await sentJob(c.id, "1", { title: "Dev A" });
    const b = await sentJob(c.id, "2", { title: "Dev B" });
    await store.recordDelivery(a, String(MEMBER), 900, T0);

    await handleUpdate(callback(`a:${a}`), deps());
    expect(await send("/applied", { from: MEMBER })).toContain("haven't marked any jobs");
    expect(await send("/applied")).toContain("Dev A");

    await handleUpdate(callback(`s:${a}`, { from: MEMBER, messageId: 900 }), deps());
    await handleUpdate(callback(`a:${b}`, { from: MEMBER, messageId: 901 }), deps());
    expect(tg.edits.at(-2)).toEqual({ chatId: MEMBER, messageId: 900, markup: jobKeyboard(a, "skipped") });
    expect(tg.edits.at(-1)).toEqual({ chatId: MEMBER, messageId: 901, markup: jobKeyboard(b, "applied") });

    const memberApplied = await send("/applied", { from: MEMBER });
    expect(memberApplied).toContain("Dev B");
    expect(memberApplied).not.toContain("Dev A");
    const ownerApplied = await send("/applied");
    expect(ownerApplied).toContain("Dev A");
    expect(ownerApplied).not.toContain("Dev B");
    expect(await ownerAction(a)).toBe("applied");
  });

  it("records a tap on a legacy owner alert (sent before deliveries existed) with its message id", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1", { title: "Legacy role" });
    expect(await store.getDelivery(id, String(OWNER))).toBeNull();

    await handleUpdate(callback(`a:${id}`, { messageId: 4242 }), deps());
    expect(tg.answers.at(-1)?.text).toBe("Marked applied");
    expect(tg.edits.at(-1)).toEqual({ chatId: OWNER, messageId: 4242, markup: jobKeyboard(id, "applied") });
    expect(await store.getDelivery(id, String(OWNER))).toMatchObject({
      telegramMessageId: 4242,
      sentAt: T0,
      userAction: "applied",
      actionAt: T0,
    });
    expect(await send("/applied")).toContain("Legacy role");
    expect(await send("/applied", { from: MEMBER })).toContain("haven't marked any jobs");
  });

  it("still lists the owner's jobs marked applied before per-user tracking, but not for members", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1", { title: "Old applied role" });
    await env.DB.prepare("UPDATE jobs SET user_action = 'applied', action_at = ? WHERE id = ?").bind(T0, id).run();
    expect(await send("/applied")).toContain("Old applied role");
    expect(await send("/applied", { from: MEMBER })).toContain("haven't marked any jobs");
  });
});

describe("unknown users", () => {
  it("replies once with their id and notifies the owner once, then stays silent", async () => {
    await send("hello", { from: STRANGER, firstName: "Eve <x>", username: "eve_k" });
    expect(tg.sent).toHaveLength(2);
    expect(tg.sent[0]!.chatId).toBe(STRANGER);
    expect(tg.sent[0]!.html).toBe(
      `This bot is private. Your Telegram user id is <code>${STRANGER}</code> — send it to the bot owner to request access.`,
    );
    expect(tg.sent[1]!.chatId).toBe(String(OWNER));
    expect(tg.sent[1]!.html).toContain(`Access request from Eve &lt;x&gt; (@eve_k) — id <code>${STRANGER}</code>`);
    expect(tg.sent[1]!.html).toContain(`Tap to allow: <code>/invite ${STRANGER}</code>`);

    await send("/start", { from: STRANGER });
    await send("please?", { from: STRANGER });
    expect(tg.sent).toHaveLength(2);
    const rows = await env.DB.prepare("SELECT user_id, name FROM access_requests").all();
    expect(rows.results).toEqual([{ user_id: String(STRANGER), name: "Eve <x> (@eve_k)" }]);
  });

  it("still notifies the owner if the reply to the stranger fails", async () => {
    tg.failFor.set(String(STRANGER), new TelegramError("Forbidden", 403, "Forbidden: bot was blocked by the user"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await send("hi", { from: STRANGER });
    expect(tg.sent.map((m) => m.chatId)).toEqual([String(OWNER)]);
    error.mockRestore();
  });

  it("uses the requester's name on invite and keeps a revoked user silent", async () => {
    await send("hi", { from: STRANGER, firstName: "Eve" });
    await send(`/invite ${STRANGER}`);
    expect(await store.getUser(String(STRANGER))).toMatchObject({ name: "Eve", active: true });
    expect(await send("/applied", { from: STRANGER })).toContain("haven't marked any jobs");

    await send(`/revoke ${STRANGER}`);
    tg.sent.length = 0;
    await send("/status", { from: STRANGER });
    expect(tg.sent).toEqual([]);
  });
});

describe("/invite", () => {
  it("validates the user id", async () => {
    for (const arg of ["", "abc", "12a", "-5", "0", "000", "1".repeat(21), "1 2"]) {
      expect(await send(`/invite ${arg}`.trim())).toContain("Usage: /invite");
    }
    expect(await store.listUsers()).toEqual([]);
    expect(parseUserId("00123")).toBe("123");
    expect(parseUserId("9".repeat(20))).toBe("9".repeat(20));
  });

  it("refuses the owner's own id", async () => {
    expect(await send(`/invite ${OWNER}`)).toBe("You're already the owner.");
    expect(await store.listUsers()).toEqual([]);
  });

  it("adds the user, welcomes them, and reports an existing user", async () => {
    const reply = await send(`/invite ${MEMBER}`);
    expect(tg.sent[0]).toEqual({ chatId: String(MEMBER), html: WELCOME_TEXT });
    expect(tg.sent[1]!.chatId).toBe(OWNER);
    expect(reply).toContain(`Added id <code>${MEMBER}</code>`);
    expect(reply).toContain("welcome message was sent");
    expect(await store.listRecipients(String(OWNER))).toEqual([String(OWNER), String(MEMBER)]);

    tg.sent.length = 0;
    expect(await send(`/invite ${MEMBER}`)).toContain("already has access");
    expect(tg.sent).toHaveLength(1);
  });

  it("tells the owner when the new user hasn't pressed Start (403)", async () => {
    tg.failFor.set(String(MEMBER), new TelegramError("Forbidden", 403, "Forbidden: bot can't initiate conversation with a user"));
    const reply = await send(`/invite ${MEMBER}`);
    expect(reply).toContain("Added, but they need to open the bot and press Start before alerts can reach them.");
    expect(await store.isActiveUser(String(MEMBER))).toBe(true);
  });

  it("re-adds a revoked user", async () => {
    await send(`/invite ${MEMBER}`);
    await send(`/revoke ${MEMBER}`);
    expect(await send(`/invite ${MEMBER}`)).toContain("Re-added");
    expect(await store.isActiveUser(String(MEMBER))).toBe(true);
  });
});

describe("/revoke", () => {
  it("deactivates a member, who then gets no member commands or alerts", async () => {
    await store.inviteUser(String(MEMBER));
    expect(await send(`/revoke ${MEMBER}`)).toContain(`Revoked id <code>${MEMBER}</code>`);
    expect(await store.listRecipients(String(OWNER))).toEqual([String(OWNER)]);
    expect(await store.isActiveUser(String(MEMBER))).toBe(false);

    tg.sent.length = 0;
    await send("/status", { from: MEMBER });
    expect(tg.sent.some((m) => m.html.includes("<b>Status</b>"))).toBe(false);
  });

  it("validates and reports unknown ids", async () => {
    expect(await send("/revoke")).toContain("Usage: /revoke");
    expect(await send("/revoke x1")).toContain("Usage: /revoke");
    expect(await send(`/revoke ${OWNER}`)).toBe("You can't revoke the owner.");
    expect(await send("/revoke 999")).toContain("isn't an invited user");
  });
});

describe("/users", () => {
  it("says when nobody is invited", async () => {
    expect(await send("/users")).toBe("No invited users.");
  });

  it("lists active users with name, id and date, escaped", async () => {
    await store.recordAccessRequest("500", "Ann <A> (@ann)", T0);
    await store.inviteUser("500", T0);
    await store.inviteUser("600", T0 + 86_400_000);
    await store.inviteUser("700", T0);
    await store.revokeUser("700");
    expect(await send("/users")).toBe(
      [
        "<b>Invited users (2)</b>",
        "• Ann &lt;A&gt; (@ann) (id <code>500</code>) — added 2026-10-06",
        "• id <code>600</code> — added 2026-10-07",
      ].join("\n"),
    );
  });
});

describe("/report", () => {
  beforeEach(async () => {
    clock = T0; // Tue Oct 6 2026, 09:00 Brazil time
    await store.inviteUser(String(MEMBER));
  });

  it("is listed in both help texts", async () => {
    expect(await send("/help")).toContain("/report");
    expect(await send("/help", { from: MEMBER })).toContain("/report");
  });

  it("replies to the owner with today's report so far", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1", { title: "Owner role" });
    await store.recordDelivery(id, String(OWNER), 1, T0);
    await handleUpdate(callback(`a:${id}`), deps());
    const reply = await send("/report");
    expect(tg.sent.at(-1)?.chatId).toBe(OWNER);
    expect(reply).toContain("Daily report — Tuesday, Oct 6");
    expect(reply).toContain("Applied today: 1");
    expect(reply).toContain("Alerts received today: 1");
    expect(reply).toContain("Today's applications:");
    expect(reply).toContain("Owner role</a> — Acme");
  });

  it("replies to a member with their own report only", async () => {
    const c = await addCompany("Acme", "acme");
    const id = await sentJob(c.id, "1", { title: "Owner role" });
    await handleUpdate(callback(`a:${id}`), deps());
    const reply = await send("/report", { from: MEMBER });
    expect(tg.sent.at(-1)?.chatId).toBe(MEMBER);
    expect(reply).toContain("Applied today: 0");
    expect(reply).toContain("No applications today");
    expect(reply).not.toContain("Owner role");
  });

  it("is not available to unknown users", async () => {
    await send("/report", { from: STRANGER });
    expect(tg.sent.some((m) => m.html.includes("Daily report"))).toBe(false);
    expect(tg.sent.find((m) => m.chatId === STRANGER)?.html).toContain("This bot is private");
  });
});
