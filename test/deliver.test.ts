import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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

  it("does nothing when called with no pending jobs", async () => {
    const stats = await deliver({ ...t.deps, excludedWords: [] });
    expect(stats).toEqual({ sent: 0, excluded: 0, detailFailures: 0, sendFailures: 0 });
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
