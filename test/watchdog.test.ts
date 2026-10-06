import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILING_AFTER_CONSECUTIVE } from "../src/core/config";
import type { StatusCounts } from "../src/core/store/db";
import { Store } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";
import { TelegramError } from "../src/core/telegram/client";
import { buildStatus, evaluateHealth, runWatchdog } from "../src/worker/watchdog";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const OWNER = "42";

let store: Store;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM companies"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  store = new Store(bindingDriver(env.DB), () => T0);
});

function fakeTelegram(fail = false) {
  const sent: { chatId: number | string; html: string }[] = [];
  return {
    sent,
    async sendMessage(chatId: number | string, html: string) {
      if (fail) throw new TelegramError("Telegram sendMessage failed (500): boom", 500, "boom");
      sent.push({ chatId, html });
      return { messageId: sent.length };
    },
  };
}

async function seedCompanies(total: number, failing: number, namePrefix = "Co") {
  for (let i = 0; i < total; i++) {
    const { company } = await store.insertCompany({ name: `${namePrefix} ${i}`, ats: "lever", boardToken: `co-${i}`, state: "active" });
    if (i < failing) {
      await env.DB.prepare("UPDATE companies SET consecutive_failures = ? WHERE id = ?")
        .bind(FAILING_AFTER_CONSECUTIVE, company.id)
        .run();
    }
  }
}

async function polled(agoMs: number) {
  await store.setSetting("last_poll_start_at", T0 - agoMs);
  await store.setSetting("last_successful_poll_at", T0 - agoMs);
}

const counts = (o: Partial<StatusCounts> = {}): StatusCounts => ({
  sentToday: 0,
  active: 10,
  failing: 0,
  pendingValidation: 0,
  pending: 0,
  ...o,
});

describe("evaluateHealth", () => {
  it("is silent on a fresh install with no polls and no active companies", () => {
    const { warnings } = evaluateHealth({ settings: { paused: false, excludedWords: [] }, counts: counts({ active: 0 }), now: T0 });
    expect(warnings).toEqual([]);
  });

  it("warns when there are active companies but no successful poll ever", () => {
    const { warnings } = evaluateHealth({ settings: { paused: false, excludedWords: [] }, counts: counts(), now: T0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Poll job boards");
  });

  it("warns on a 4h-old successful poll", () => {
    const { warnings } = evaluateHealth({
      settings: { paused: false, excludedWords: [], lastSuccessfulPollAt: T0 - 4 * HOUR, lastPollStartAt: T0 - 4 * HOUR },
      counts: counts(),
      now: T0,
    });
    expect(warnings).toEqual([
      "⚠️ No successful job check for 4h. Check the GitHub Actions 'Poll job boards' workflow (disabled? out of minutes? bad secret?).",
    ]);
  });

  it("warns at 30% failing but not at 10%", () => {
    const settings = { paused: false, excludedWords: [], lastSuccessfulPollAt: T0 - HOUR };
    expect(evaluateHealth({ settings, counts: counts({ active: 30, failing: 9 }), now: T0 }).warnings).toEqual([
      "⚠️ 9 of 30 companies are failing. Send /companies to see which.",
    ]);
    expect(evaluateHealth({ settings, counts: counts({ active: 30, failing: 3 }), now: T0 }).warnings).toEqual([]);
  });
});

describe("runWatchdog", () => {
  it("sends one warning for a 4h-old poll, then none within 6h, then again after 6h", async () => {
    await seedCompanies(10, 0);
    await polled(4 * HOUR);
    const tg = fakeTelegram();

    expect(await runWatchdog(store, tg, OWNER, T0)).toEqual({ sent: true });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe(OWNER);
    expect(tg.sent[0]!.html).toContain("No successful job check for 4h");
    expect((await store.getSettings()).lastWarningAt).toBe(T0);

    expect(await runWatchdog(store, tg, OWNER, T0 + HOUR)).toEqual({ sent: false });
    expect(await runWatchdog(store, tg, OWNER, T0 + 5 * HOUR)).toEqual({ sent: false });
    expect(tg.sent).toHaveLength(1);

    expect(await runWatchdog(store, tg, OWNER, T0 + 6 * HOUR)).toEqual({ sent: true });
    expect(tg.sent).toHaveLength(2);
  });

  it("warns when 30% of companies are failing", async () => {
    await seedCompanies(10, 3);
    await polled(HOUR);
    const tg = fakeTelegram();
    expect(await runWatchdog(store, tg, OWNER, T0)).toEqual({ sent: true });
    expect(tg.sent[0]!.html).toContain("3 of 10 companies are failing");
  });

  it("combines both warnings into one message", async () => {
    await seedCompanies(10, 3);
    await polled(5 * HOUR);
    const tg = fakeTelegram();
    await runWatchdog(store, tg, OWNER, T0);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.html).toContain("No successful job check");
    expect(tg.sent[0]!.html).toContain("3 of 10 companies are failing");
  });

  it("does not warn when 10% of companies are failing", async () => {
    await seedCompanies(10, 1);
    await polled(HOUR);
    const tg = fakeTelegram();
    expect(await runWatchdog(store, tg, OWNER, T0)).toEqual({ sent: false });
    expect(tg.sent).toHaveLength(0);
  });

  it("does not warn in a healthy state", async () => {
    await seedCompanies(5, 0);
    await polled(30 * 60 * 1000);
    const tg = fakeTelegram();
    expect(await runWatchdog(store, tg, OWNER, T0)).toEqual({ sent: false });
    expect(tg.sent).toHaveLength(0);
    expect((await store.getSettings()).lastWarningAt).toBeUndefined();
  });

  it("stays silent on a fresh install", async () => {
    const tg = fakeTelegram();
    expect(await runWatchdog(store, tg, OWNER, T0)).toEqual({ sent: false });
    expect(tg.sent).toHaveLength(0);
  });

  it("does not throw when Telegram fails, and retries next run", async () => {
    await seedCompanies(4, 0);
    await polled(4 * HOUR);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runWatchdog(store, fakeTelegram(true), OWNER, T0)).toEqual({ sent: false });
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect((await store.getSettings()).lastWarningAt).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
    const tg = fakeTelegram();
    expect(await runWatchdog(store, tg, OWNER, T0 + HOUR)).toEqual({ sent: true });
  });
});

describe("buildStatus", () => {
  it("reports 2 failing companies with their names", async () => {
    await seedCompanies(10, 2);
    await env.DB.prepare("UPDATE companies SET name = ? WHERE board_token = 'co-0'").bind("A<B & Co").run();
    await store.insertCompany({ name: "Pending Inc", ats: "greenhouse", boardToken: "pending" });
    await polled(2 * HOUR);
    await store.setSetting("last_poll_stats", { companiesOk: 8, companiesFailed: 2, sent: 4 });

    const html = await buildStatus(store, T0);
    expect(html).toContain("Companies failing: 2");
    expect(html).toContain("A&lt;B &amp; Co");
    expect(html).not.toContain("A<B");
    expect(html).toContain("Co 1");
    expect(html).toContain("Companies active: 10");
    expect(html).toContain("Companies waiting for validation: 1");
    expect(html).toContain("Last check: 2h ago");
    expect(html).toContain("Last successful check: 2h ago");
    expect(html).toContain("Last poll: 8 boards ok, 2 failed, 4 jobs sent");
    expect(html).toContain("Running");
  });

  it("shows never-polled and paused state", async () => {
    await store.pause();
    const html = await buildStatus(store, T0);
    expect(html).toContain("Paused");
    expect(html).toContain("Last check: never");
    expect(html).toContain("Last successful check: never");
    expect(html).not.toContain("Last poll:");
  });
});
