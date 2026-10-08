import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_MAX_RECIPIENTS, REPORT_TZ_OFFSET_MIN } from "../src/core/config";
import { type AppliedJob, type NewJob, Store } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";
import { TelegramError } from "../src/core/telegram/client";
import {
  brazilDayStart,
  brazilWeekStart,
  buildReport,
  formatBrazilDate,
  formatReport,
  reportWindow,
  runDailyReports,
} from "../src/worker/report";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const OWNER = "1001";
const MEMBER = "3003";
/** Tue Oct 6 2026 12:00 UTC = 09:00 Brazil time: when the daily cron fires. */
const CRON_AT = Date.UTC(2026, 9, 6, 12, 0, 0);
/** 00:00 BRT Tue Oct 6. */
const TODAY = Date.UTC(2026, 9, 6, 3, 0, 0);
/** 00:00 BRT Mon Oct 5 (also the start of the week). */
const YESTERDAY = TODAY - DAY;
const MONDAY = YESTERDAY;

let store: Store;
let companyId: number;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM access_requests"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM companies"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  store = new Store(bindingDriver(env.DB), () => CRON_AT);
  companyId = (await store.insertCompany({ name: "Acme", ats: "lever", boardToken: "acme", state: "active" })).company.id;
});

let seq = 0;
async function sentJob(overrides: Partial<NewJob> = {}, sentAt = YESTERDAY + HOUR): Promise<number> {
  const boardJobId = `j${++seq}`;
  await store.runBatch([
    store.stmtInsertJob(
      {
        companyId,
        boardJobId,
        title: `Engineer ${boardJobId}`,
        normalizedTitle: `engineer ${boardJobId}`,
        locationText: "Remote - US",
        applyUrl: `https://jobs.lever.co/acme/${boardJobId}`,
        status: "pending",
        ...overrides,
      },
      sentAt,
    ),
  ]);
  const row = await env.DB.prepare("SELECT id FROM jobs WHERE board_job_id = ?").bind(boardJobId).first<{ id: number }>();
  await store.markSent(row!.id, 1, sentAt);
  return row!.id;
}

/** A job delivered to `userId` at `sentAt`, optionally acted on at `actionAt`. */
async function delivered(
  userId: string,
  sentAt: number,
  action?: "applied" | "skipped",
  actionAt?: number,
  overrides: Partial<NewJob> = {},
): Promise<number> {
  const id = await sentJob(overrides, sentAt);
  await store.recordDelivery(id, userId, 1, sentAt);
  if (action) await store.setDeliveryAction(id, userId, action, actionAt ?? sentAt);
  return id;
}

function fakeTelegram() {
  const sent: { chatId: number | string; html: string }[] = [];
  const failFor = new Map<string, Error>();
  return {
    sent,
    failFor,
    async sendMessage(chatId: number | string, html: string) {
      const err = failFor.get(String(chatId));
      if (err) throw err;
      sent.push({ chatId, html });
      return { messageId: sent.length };
    },
  };
}

describe("Brazil time helpers", () => {
  it("uses a fixed UTC-3 offset", () => {
    expect(REPORT_TZ_OFFSET_MIN).toBe(-180);
  });

  it("starts the Brazil day at 03:00 UTC; 02:59 UTC belongs to the previous Brazil day", () => {
    expect(brazilDayStart(Date.UTC(2026, 9, 6, 3, 0, 0))).toBe(TODAY);
    expect(brazilDayStart(CRON_AT)).toBe(TODAY);
    expect(brazilDayStart(Date.UTC(2026, 9, 7, 2, 59, 59))).toBe(TODAY);
    expect(brazilDayStart(Date.UTC(2026, 9, 6, 2, 59, 0))).toBe(YESTERDAY);
    expect(brazilDayStart(Date.UTC(2026, 9, 6, 0, 0, 0))).toBe(YESTERDAY);
  });

  it("starts the week on Monday 00:00 Brazil time", () => {
    expect(brazilWeekStart(CRON_AT)).toBe(MONDAY); // Tuesday
    expect(brazilWeekStart(Date.UTC(2026, 9, 5, 3, 0, 0))).toBe(MONDAY); // Monday 00:00 BRT
    expect(brazilWeekStart(Date.UTC(2026, 9, 5, 2, 59, 0))).toBe(MONDAY - 7 * DAY); // still Sunday in Brazil
    expect(brazilWeekStart(Date.UTC(2026, 9, 12, 2, 0, 0))).toBe(MONDAY); // Sunday 23:00 BRT
  });

  it("formats the Brazil date", () => {
    expect(formatBrazilDate(TODAY)).toBe("Tuesday, Oct 6");
    expect(formatBrazilDate(Date.UTC(2026, 9, 6, 2, 0, 0))).toBe("Monday, Oct 5");
  });

  it("covers the previous Brazil day for the cron and today for /report", () => {
    // Cron at 12:00 UTC: 03:00 UTC yesterday to 03:00 UTC today.
    expect(reportWindow("yesterday", CRON_AT)).toEqual({ start: YESTERDAY, end: TODAY, weekStart: MONDAY });
    expect(reportWindow("today", CRON_AT)).toEqual({ start: TODAY, end: TODAY + DAY, weekStart: MONDAY });
  });

  it("uses the reported day's week, so Monday's report about Sunday shows the previous week", () => {
    const mondayCron = Date.UTC(2026, 9, 12, 12, 0, 0); // Monday Oct 12, 09:00 BRT
    const sunday = Date.UTC(2026, 9, 11, 3, 0, 0); // Sunday Oct 11 00:00 BRT
    const previousMonday = Date.UTC(2026, 9, 5, 3, 0, 0); // Monday Oct 5 00:00 BRT
    expect(reportWindow("yesterday", mondayCron)).toEqual({ start: sunday, end: sunday + DAY, weekStart: previousMonday });
  });
});

describe("formatReport", () => {
  const stats = { applied: 0, appliedWeek: 0, appliedAll: 0, skipped: 0, alerts: 0 };
  const job = (i: number, o: Partial<AppliedJob> = {}) =>
    ({ id: i, title: `Role ${i}`, companyName: "Acme", applyUrl: `https://x.test/${i}`, ...o }) as AppliedJob;

  it("still sends a report on an empty day", () => {
    expect(formatReport({ period: "yesterday", dayStart: YESTERDAY, stats, applied: [] })).toBe(
      [
        "<b>📊 Daily report — Monday, Oct 5</b>",
        "Applied yesterday: 0",
        "This week: 0 · All time: 0",
        "Skipped yesterday: 0",
        "Alerts received yesterday: 0",
        "",
        "No applications yesterday — new matching roles keep arriving every 10 minutes.",
      ].join("\n"),
    );
    expect(formatReport({ period: "today", dayStart: TODAY, stats, applied: [] })).toContain("No applications today —");
  });

  it("lists at most 25 applications, then '…and K more'", () => {
    const applied = Array.from({ length: 25 }, (_, i) => job(i + 1));
    const html = formatReport({ period: "yesterday", dayStart: YESTERDAY, stats: { ...stats, applied: 30 }, applied });
    expect(html).toContain("<b>Yesterday's applications:</b>");
    expect(html).toContain('25. <a href="https://x.test/25">Role 25</a> — Acme');
    expect(html).not.toContain("26.");
    expect(html.endsWith("…and 5 more")).toBe(true);
    expect(html).not.toContain("No applications");
  });

  it("escapes titles, companies and links", () => {
    const html = formatReport({
      period: "today",
      dayStart: TODAY,
      stats: { ...stats, applied: 1 },
      applied: [job(1, { title: "<b>Dev</b> & Ops", companyName: "A<C>", applyUrl: 'https://x.test/?a=1&b="2"' })],
    });
    expect(html).toContain("<b>Today's applications:</b>");
    expect(html).toContain('1. <a href="https://x.test/?a=1&amp;b=&quot;2&quot;">&lt;b&gt;Dev&lt;/b&gt; &amp; Ops</a> — A&lt;C&gt;');
    expect(html).not.toContain("<b>Dev");
  });
});

describe("report counts", () => {
  it("counts each user's own deliveries in the previous Brazil day", async () => {
    await delivered(OWNER, YESTERDAY + HOUR, "applied", YESTERDAY + 2 * HOUR, { title: "Yesterday A" });
    // 02:59 UTC today is still yesterday in Brazil.
    await delivered(OWNER, YESTERDAY + HOUR, "applied", TODAY - 60_000, { title: "Yesterday B" });
    await delivered(OWNER, MONDAY - 3 * DAY, "applied", MONDAY - 2 * DAY, { title: "Last week" });
    await delivered(OWNER, YESTERDAY + HOUR, "skipped", YESTERDAY + 3 * HOUR);
    await delivered(OWNER, TODAY + HOUR, "applied", TODAY + 2 * HOUR, { title: "Today role" });
    await delivered(OWNER, YESTERDAY - 60_000); // 02:59 UTC Monday: Sunday in Brazil
    await delivered(MEMBER, YESTERDAY + 5 * HOUR);

    const html = await buildReport(store, OWNER, OWNER, "yesterday", CRON_AT);
    expect(html).toContain("Daily report — Monday, Oct 5");
    expect(html).toContain("Applied yesterday: 2");
    expect(html).toContain("This week: 3 · All time: 4");
    expect(html).toContain("Skipped yesterday: 1");
    expect(html).toContain("Alerts received yesterday: 3");
    expect(html.indexOf("Yesterday B")).toBeGreaterThan(-1);
    expect(html.indexOf("Yesterday B")).toBeLessThan(html.indexOf("Yesterday A")); // newest first
    expect(html).not.toContain("Last week");
    expect(html).not.toContain("Today role");

    const member = await buildReport(store, MEMBER, OWNER, "yesterday", CRON_AT);
    expect(member).toContain("Applied yesterday: 0");
    expect(member).toContain("This week: 0 · All time: 0");
    expect(member).toContain("Alerts received yesterday: 1");
    expect(member).toContain("No applications yesterday");

    const today = await buildReport(store, OWNER, OWNER, "today", CRON_AT);
    expect(today).toContain("Daily report — Tuesday, Oct 6");
    expect(today).toContain("Applied today: 1");
    expect(today).toContain("Alerts received today: 1");
    expect(today).toContain("Today role");
    expect(today).not.toContain("Yesterday A");
  });

  it("counts a Skip→Applied switch once, as applied", async () => {
    const id = await delivered(MEMBER, YESTERDAY + HOUR, "skipped", YESTERDAY + 2 * HOUR);
    await store.setDeliveryAction(id, MEMBER, "applied", YESTERDAY + 3 * HOUR);
    const html = await buildReport(store, MEMBER, OWNER, "yesterday", CRON_AT);
    expect(html).toContain("Applied yesterday: 1");
    expect(html).toContain("Skipped yesterday: 0");
    expect(html).toContain("All time: 1");
  });

  it("includes the owner's legacy applied jobs, not for members, and not twice", async () => {
    const legacy = await sentJob({ title: "Legacy role" });
    await env.DB.prepare("UPDATE jobs SET user_action = 'applied', action_at = ? WHERE id = ?").bind(YESTERDAY + HOUR, legacy).run();
    // A legacy row the owner also has a deliveries row for: the deliveries row wins.
    const both = await sentJob({ title: "Both role" });
    await env.DB.prepare("UPDATE jobs SET user_action = 'applied', action_at = ? WHERE id = ?").bind(YESTERDAY + HOUR, both).run();
    await store.setDeliveryAction(both, OWNER, "skipped", YESTERDAY + 2 * HOUR);

    const owner = await buildReport(store, OWNER, OWNER, "yesterday", CRON_AT);
    expect(owner).toContain("Applied yesterday: 1");
    expect(owner).toContain("All time: 1");
    expect(owner).toContain("Skipped yesterday: 1");
    expect(owner).toContain("Legacy role");
    expect(owner).not.toContain("Both role");

    const member = await buildReport(store, MEMBER, OWNER, "yesterday", CRON_AT);
    expect(member).toContain("Applied yesterday: 0");
    expect(member).not.toContain("Legacy role");
  });
});

describe("runDailyReports", () => {
  it("sends every recipient their own report; a member's 403 doesn't stop the others", async () => {
    await store.inviteUser(MEMBER, CRON_AT - 2 * DAY);
    await store.inviteUser("4004", CRON_AT - DAY);
    await delivered(OWNER, YESTERDAY + HOUR, "applied", YESTERDAY + 2 * HOUR, { title: "Owner role" });
    await delivered("4004", YESTERDAY + HOUR, "applied", YESTERDAY + 2 * HOUR, { title: "Other role" });

    const tg = fakeTelegram();
    tg.failFor.set(
      MEMBER,
      new TelegramError("Telegram sendMessage failed (403)", 403, "Forbidden: bot was blocked by the user test-bot-token"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runDailyReports(store, tg, OWNER, CRON_AT, ["test-bot-token"]);
    expect(result).toEqual({ sent: 2, failed: 1, skipped: 0 });
    expect(tg.sent.map((m) => String(m.chatId))).toEqual([OWNER, "4004"]);
    expect(tg.sent[0]!.html).toContain("Owner role");
    expect(tg.sent[0]!.html).not.toContain("Other role");
    expect(tg.sent[1]!.html).toContain("Other role");
    expect(tg.sent[1]!.html).not.toContain("Owner role");
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("403");
    expect(logged).not.toContain("test-bot-token");
    spy.mockRestore();
  });

  it(`processes at most ${REPORT_MAX_RECIPIENTS} recipients per run and logs the rest`, async () => {
    for (let i = 0; i < REPORT_MAX_RECIPIENTS + 5; i++) await store.inviteUser(String(5000 + i), CRON_AT + i);
    const tg = fakeTelegram();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runDailyReports(store, tg, OWNER, CRON_AT);
    expect(result).toEqual({ sent: REPORT_MAX_RECIPIENTS, failed: 0, skipped: 6 });
    expect(tg.sent).toHaveLength(REPORT_MAX_RECIPIENTS);
    expect(String(tg.sent[0]!.chatId)).toBe(OWNER);
    expect(spy.mock.calls.flat().join(" ")).toContain("6 skipped");
    spy.mockRestore();
  });
});
