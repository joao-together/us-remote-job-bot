import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramError } from "../src/core/telegram/client";
import { deliver } from "../src/poller/deliver";
import { runPoll } from "../src/poller/run";
import ghDetailNoPay from "./fixtures/greenhouse/detail-no-pay.json";
import ghDetailPay from "./fixtures/greenhouse/detail-pay.json";
import {
  HOUR,
  addCompany,
  emptyBoards,
  greenhouseJob,
  jobRows,
  jobStatus,
  leverPosting,
  resetDb,
  setup,
  type Boards,
} from "./poller-helpers";

let boards: Boards;
let t: ReturnType<typeof setup>;

beforeEach(async () => {
  await resetDb();
  boards = emptyBoards();
  t = setup(boards);
});

async function poll() {
  const stats = await runPoll(t.deps);
  t.clock.now += HOUR;
  return stats;
}

/** A baselined Greenhouse company with the given new jobs listed on its board. */
async function greenhouseWith(...jobs: ReturnType<typeof greenhouseJob>[]) {
  boards.greenhouse.globex = jobs;
  await addCompany(t.store, "Globex", "greenhouse", "globex", { baselined: true });
}

/** Inserts pending Greenhouse jobs for a baselined Globex directly, bypassing the poll. */
async function pendingGreenhouse(...jobs: [id: string, title: string][]) {
  const companyId = await addCompany(t.store, "Globex", "greenhouse", "globex", { baselined: true });
  await t.store.runBatch(
    jobs.map(([boardJobId, title]) =>
      t.store.stmtInsertJob({
        companyId,
        boardJobId,
        title,
        normalizedTitle: title.toLowerCase(),
        locationText: "Remote - US",
        locationClass: "us",
        applyUrl: `https://job-boards.greenhouse.io/globex/jobs/${boardJobId}`,
        status: "pending",
      }),
    ),
  );
}

function detail(base: object, content: string) {
  return { ...base, content };
}

describe("deliver", () => {
  it("excludes a Greenhouse job whose detail description has an excluded word (AE4)", async () => {
    await t.store.addExcludedWord("clearance");
    await greenhouseWith(greenhouseJob(11, "Senior Software Engineer"));
    boards.ghDetail["11"] = detail(ghDetailNoPay, "&lt;p&gt;Must hold a security clearance.&lt;/p&gt;");

    const stats = await poll();

    expect(await jobStatus("11")).toBe("excluded");
    expect(t.telegram.sends).toEqual([]);
    expect(stats.sent).toBe(0);
  });

  it("adds the salary from the Greenhouse detail and sends", async () => {
    await greenhouseWith(greenhouseJob(12, "Senior Software Engineer"));
    boards.ghDetail["12"] = ghDetailPay;

    await poll();

    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toContain("💰 $170,000");
    expect(t.telegram.sends[0]!.markup?.inline_keyboard[0]?.map((b) => b.callback_data)[0]).toMatch(/^a:\d+$/);
    expect((await jobRows())[0]).toMatchObject({ status: "sent", salary_text: expect.stringContaining("170,000") });
  });

  it("leaves a job pending when its detail fetch fails, then sends it next run", async () => {
    await greenhouseWith(greenhouseJob(13, "Senior Frontend Engineer"));

    await poll();
    expect(await jobStatus("13")).toBe("pending");
    expect(t.telegram.sends).toEqual([]);

    boards.ghDetail["13"] = ghDetailNoPay;
    await poll();
    expect(await jobStatus("13")).toBe("sent");
    expect(t.telegram.sends).toHaveLength(1);
  });

  it("never resends a job whose send failed after it was marked sending", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme = [leverPosting("f1", "Senior Software Engineer"), leverPosting("f2", "Senior Backend Engineer")];
    t.telegram.failNext = true;
    const stats = await poll();

    expect(stats).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(await jobStatus("f1")).toBe("sending");
    expect(await jobStatus("f2")).toBe("pending");

    const next = await poll();
    expect(next).toMatchObject({ sent: 1, sendFailures: 0 });
    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toContain("Senior Backend Engineer");
    expect(await jobStatus("f1")).toBe("sending");
    expect(await jobStatus("f2")).toBe("sent");
  });

  it("retries a job next run when Telegram definitely rejected it (4xx)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme = [leverPosting("r1", "Senior Software Engineer")];
    t.telegram.failNext = true;
    t.telegram.failWith = new TelegramError("Too Many Requests", 429, "Too Many Requests: retry after 5", 5);
    const stats = await poll();

    expect(stats).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(await jobStatus("r1")).toBe("pending");

    const next = await poll();
    expect(next).toMatchObject({ sent: 1, sendFailures: 0 });
    expect(await jobStatus("r1")).toBe("sent");
  });

  it("delivers oldest first with spacing between sends", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme = [leverPosting("o1", "Senior Software Engineer")];
    await poll();
    // Put o1 back to pending, then list a newer job.
    await t.deps.store.runBatch([{ sql: "UPDATE jobs SET status = 'pending', telegram_message_id = NULL WHERE board_job_id = 'o1'" }]);
    t.telegram.sends.length = 0;
    boards.lever.acme.push(leverPosting("o2", "Senior Mobile Engineer"));
    await poll();

    expect(t.telegram.sends.map((s) => s.html.split("\n")[0])).toEqual([
      "<b>Senior Software Engineer</b>",
      "<b>Senior Mobile Engineer</b>",
    ]);
    expect(t.sleeps).toEqual([1100]);
  });

  it("stops cleanly when the delivery time budget is spent and finishes next run", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme = [
      leverPosting("b1", "Senior Software Engineer"),
      leverPosting("b2", "Senior Backend Engineer"),
      leverPosting("b3", "Senior Mobile Engineer"),
    ];
    // Each spacing sleep advances the clock past the 6-minute budget after the second send.
    t.deps.sleep = async () => {
      t.clock.now += 7 * 60 * 1000;
    };
    const stats = await poll();
    expect(stats.sent).toBe(2);
    const statuses = await Promise.all(["b1", "b2", "b3"].map(jobStatus));
    expect(statuses).toEqual(["sent", "sent", "pending"]);

    const next = await poll();
    expect(next.sent).toBe(1);
    expect(await jobStatus("b3")).toBe("sent");
  });

  it("does nothing when called with no pending jobs", async () => {
    const stats = await deliver({ ...t.deps, excludedWords: [] });
    expect(stats).toEqual({ sent: 0, messagesSent: 0, excluded: 0, detailFailures: 0, gone: 0, sendFailures: 0 });
    expect(t.telegram.getMeCalls).toBe(0);
  });

  it("stops sending when /pause lands mid-delivery (#6)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme = [leverPosting("m1", "Senior Software Engineer"), leverPosting("m2", "Senior Backend Engineer")];
    t.telegram.onSend = async () => {
      t.telegram.onSend = undefined;
      await t.store.pause();
    };
    const stats = await poll();

    expect(stats.sent).toBe(1);
    expect(t.telegram.sends).toHaveLength(1);
    expect(await jobStatus("m1")).toBe("sent");
    expect(await jobStatus("m2")).toBe("suppressed");
  });

  it("retires a pending job whose posting is gone (detail 404) (#7)", async () => {
    await pendingGreenhouse(["41", "Senior Software Engineer"], ["42", "Senior Backend Engineer"]);
    boards.ghGone.add("41");
    boards.ghDetail["42"] = ghDetailNoPay;

    const stats = await deliver({ ...t.deps, excludedWords: [] });

    expect(stats).toMatchObject({ gone: 1, sent: 1, detailFailures: 0 });
    expect(await jobStatus("41")).toBe("seen");
    expect(await jobStatus("42")).toBe("sent");
    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toContain("Senior Backend Engineer");
  });

  it("sends a job unenriched once its detail has failed for over 48h (#7)", async () => {
    await t.store.addExcludedWord("clearance");
    await greenhouseWith(greenhouseJob(43, "Senior Software Engineer"), greenhouseJob(44, "Senior Software Engineer, Clearance Required"));

    // Detail keeps failing (503): stays pending while young.
    await poll();
    expect(await jobStatus("43")).toBe("pending");
    t.clock.now += 40 * HOUR;
    await poll();
    expect(await jobStatus("43")).toBe("pending");
    expect(t.telegram.sends).toEqual([]);

    // Past 48h: sent without description/salary; the excluded-word check uses the title only.
    t.clock.now += 10 * HOUR;
    const stats = await poll();
    expect(stats.sent).toBe(1);
    expect(await jobStatus("43")).toBe("sent");
    expect(await jobStatus("44")).toBe("excluded");
    expect(t.telegram.sends[0]!.html).toContain("Senior Software Engineer");
    expect(t.telegram.sends[0]!.html).not.toContain("💰");
  });

  it("claims no job while Telegram is unreachable, then sends everything next run (#8)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme = [leverPosting("g1", "Senior Software Engineer"), leverPosting("g2", "Senior Backend Engineer")];
    t.telegram.failGetMe = true;
    const stats = await poll();

    expect(stats).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(await jobStatus("g1")).toBe("pending");
    expect(await jobStatus("g2")).toBe("pending");
    expect(t.telegram.sends).toEqual([]);

    t.telegram.failGetMe = false;
    t.telegram.getMeCalls = 0;
    const next = await poll();
    expect(next).toMatchObject({ sent: 2, sendFailures: 0 });
    expect(await jobStatus("g1")).toBe("sent");
    expect(await jobStatus("g2")).toBe("sent");
    expect(t.telegram.getMeCalls).toBe(1);
  });
});

describe("location warnings", () => {
  it("shows the location reason stored at detection", async () => {
    await greenhouseWith(
      greenhouseJob(21, "Senior Software Engineer", "Remote - US (CA, NY, TX only)"),
      greenhouseJob(22, "Senior Backend Engineer", "United States"),
      greenhouseJob(23, "Senior Frontend Engineer", "Remote - US"),
    );
    for (const id of ["21", "22", "23"]) boards.ghDetail[id] = ghDetailNoPay;

    await poll();

    const rows = await env.DB.prepare("SELECT board_job_id, location_class, location_reason FROM jobs ORDER BY board_job_id").all();
    expect(rows.results).toEqual([
      { board_job_id: "21", location_class: "us_restricted", location_reason: "Limited to some US states: CA, NY, TX" },
      { board_job_id: "22", location_class: "ambiguous", location_reason: "Doesn't say remote; location is just the US" },
      { board_job_id: "23", location_class: "us", location_reason: null },
    ]);
    const html = t.telegram.sends.map((s) => s.html);
    expect(html).toHaveLength(3);
    expect(html[0]).toContain("⚠️ Limited to some US states: CA, NY, TX");
    expect(html[1]).toContain("⚠️ Doesn't say remote; location is just the US");
    expect(html[2]).not.toContain("⚠️");
  });

  it("falls back to the formatter's generic reason when none was stored", async () => {
    const id = await addCompany(t.store, "Globex", "greenhouse", "globex", { baselined: true });
    await t.store.runBatch([
      t.store.stmtInsertJob({
        companyId: id,
        boardJobId: "31",
        title: "Senior Software Engineer",
        normalizedTitle: "senior software engineer",
        locationText: "Somewhere",
        locationClass: null,
        applyUrl: "https://job-boards.greenhouse.io/globex/jobs/31",
        status: "pending",
      }),
    ]);
    boards.ghDetail["31"] = ghDetailNoPay;

    await deliver({ ...t.deps, excludedWords: [] });

    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toContain("⚠️ Check location eligibility");
  });
});

describe("multiple recipients", () => {
  const OWNER = "1001";
  const ALICE = "3003";
  const BOB = "4004";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function deliveries() {
    const res = await env.DB.prepare(
      "SELECT j.board_job_id, d.user_id, d.telegram_message_id FROM deliveries d JOIN jobs j ON j.id = d.job_id ORDER BY j.id, d.sent_at, d.user_id",
    ).all();
    return res.results;
  }

  /** Baselines Acme, then lists the given new jobs on its board. */
  async function acmeWith(...ids: string[]) {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme = ids.map((id) => leverPosting(id, `Senior Software Engineer ${id}`));
  }

  it("sends the same alert to the owner and every active member, with spacing and a delivery row each", async () => {
    await t.store.inviteUser(ALICE, 1);
    await t.store.inviteUser(BOB, 2);
    await acmeWith("m1", "m2");

    const stats = await poll();

    expect(stats).toMatchObject({ sent: 2, messagesSent: 6, sendFailures: 0 });
    expect(t.telegram.sends.map((s) => [s.chatId, s.html.split("\n")[0]])).toEqual([
      [OWNER, "<b>Senior Software Engineer m1</b>"],
      [ALICE, "<b>Senior Software Engineer m1</b>"],
      [BOB, "<b>Senior Software Engineer m1</b>"],
      [OWNER, "<b>Senior Software Engineer m2</b>"],
      [ALICE, "<b>Senior Software Engineer m2</b>"],
      [BOB, "<b>Senior Software Engineer m2</b>"],
    ]);
    expect(new Set(t.telegram.sends.map((s) => s.html)).size).toBe(2);
    expect(t.sleeps).toEqual([1100, 1100, 1100, 1100, 1100]);
    expect(await deliveries()).toEqual([
      { board_job_id: "m1", user_id: OWNER, telegram_message_id: 500 },
      { board_job_id: "m1", user_id: ALICE, telegram_message_id: 501 },
      { board_job_id: "m1", user_id: BOB, telegram_message_id: 502 },
      { board_job_id: "m2", user_id: OWNER, telegram_message_id: 503 },
      { board_job_id: "m2", user_id: ALICE, telegram_message_id: 504 },
      { board_job_id: "m2", user_id: BOB, telegram_message_id: 505 },
    ]);
    expect((await jobRows()).map((r) => [r.board_job_id, r.status, r.telegram_message_id])).toEqual([
      ["m1", "sent", 500],
      ["m2", "sent", 503],
    ]);
  });

  it("skips a member whose send fails (403) without stopping the owner or others", async () => {
    await t.store.inviteUser(ALICE, 1);
    await t.store.inviteUser(BOB, 2);
    t.telegram.failFor.set(ALICE, new TelegramError("Telegram sendMessage failed (403): Forbidden: bot was blocked by the user", 403, "Forbidden: bot was blocked by the user"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await acmeWith("b1", "b2");

    const stats = await poll();

    expect(stats).toMatchObject({ sent: 2, messagesSent: 4, sendFailures: 2 });
    expect(t.telegram.sends.map((s) => s.chatId)).toEqual([OWNER, BOB, OWNER, BOB]);
    expect(await jobStatus("b1")).toBe("sent");
    expect(await jobStatus("b2")).toBe("sent");
    expect((await deliveries()).map((d) => d.user_id)).toEqual([OWNER, BOB, OWNER, BOB]);
    const logged = error.mock.calls.flat().join("\n");
    expect(logged).toContain("recipient #2 failed for job");
    expect(logged).toContain("403");
    expect(logged).not.toContain(ALICE);
  });

  it("stops the run without reaching members when the owner's send fails ambiguously", async () => {
    await t.store.inviteUser(ALICE, 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await acmeWith("o1", "o2");
    t.telegram.failNext = true;

    const stats = await poll();

    expect(stats).toMatchObject({ sent: 0, messagesSent: 0, sendFailures: 1 });
    expect(t.telegram.sends).toEqual([]);
    expect(await jobStatus("o1")).toBe("sending");
    expect(await jobStatus("o2")).toBe("pending");
    expect(await deliveries()).toEqual([]);
  });

  it("reverts and stops when Telegram rejects the owner's send (4xx)", async () => {
    await t.store.inviteUser(ALICE, 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await acmeWith("r1");
    t.telegram.failNext = true;
    t.telegram.failWith = new TelegramError("Too Many Requests", 429, "Too Many Requests: retry after 5", 5);

    expect(await poll()).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(await jobStatus("r1")).toBe("pending");
    expect(t.telegram.sends).toEqual([]);

    expect(await poll()).toMatchObject({ sent: 1, messagesSent: 2 });
    expect(t.telegram.sends.map((s) => s.chatId)).toEqual([OWNER, ALICE]);
  });

  it("stops sending to a revoked member", async () => {
    await t.store.inviteUser(ALICE, 1);
    await acmeWith("v1");
    await poll();
    expect(t.telegram.sends.map((s) => s.chatId)).toEqual([OWNER, ALICE]);

    await t.store.revokeUser(ALICE);
    boards.lever.acme!.push(leverPosting("v2", "Senior Backend Engineer"));
    t.telegram.sends.length = 0;
    expect(await poll()).toMatchObject({ sent: 1, messagesSent: 1 });
    expect(t.telegram.sends.map((s) => s.chatId)).toEqual([OWNER]);
  });

  it("never stores the owner as a member recipient twice", async () => {
    await t.store.inviteUser(OWNER, 1);
    await acmeWith("d1");
    await poll();
    expect(t.telegram.sends.map((s) => s.chatId)).toEqual([OWNER]);
  });
});
