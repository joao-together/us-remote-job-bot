import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mapPool, redactError, runPoll } from "../src/poller/run";
import leverFixture from "./fixtures/lever/postings.json";
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

const SENIOR = "Senior Software Engineer";

let boards: Boards;
let t: ReturnType<typeof setup>;

beforeEach(async () => {
  await resetDb();
  boards = emptyBoards();
  t = setup(boards);
});

async function companyRow(id: number) {
  return env.DB.prepare("SELECT state, baselined, consecutive_failures, last_error FROM companies WHERE id = ?")
    .bind(id)
    .first<{ state: string; baselined: number; consecutive_failures: number; last_error: string | null }>();
}

async function poll() {
  const stats = await runPoll(t.deps);
  t.clock.now += HOUR;
  return stats;
}

describe("baseline", () => {
  it("stores a seeded company's first fetch as seen and sends nothing", async () => {
    boards.lever.acme = [1, 2, 3, 4, 5].map((i) => leverPosting(`j${i}`, `${SENIOR} ${i}`));
    const id = await addCompany(t.store, "Acme", "lever", "acme");

    const stats = await poll();

    expect(t.telegram.sends).toEqual([]);
    expect((await jobRows()).map((r) => r.status)).toEqual(["seen", "seen", "seen", "seen", "seen"]);
    expect(await companyRow(id)).toMatchObject({ state: "active", baselined: 1, consecutive_failures: 0 });
    expect(stats).toMatchObject({ companiesOk: 1, companiesFailed: 0, newJobs: 5, matched: 0, sent: 0 });
  });

  it("baselines a real-shaped board silently", async () => {
    boards.lever.spotify = leverFixture;
    await addCompany(t.store, "Spotify", "lever", "spotify");
    await poll();
    expect(t.telegram.sends).toEqual([]);
    expect((await jobRows()).every((r) => r.status === "seen")).toBe(true);
    expect(await jobRows()).toHaveLength(leverFixture.length);
  });
});

describe("detection and delivery", () => {
  it("sends exactly one alert for one new matching job and records the message id", async () => {
    boards.lever.acme = [leverPosting("old", SENIOR)];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme.push(
      leverPosting("new", "Senior Backend Engineer"),
      leverPosting("staff", "Staff Software Engineer"),
      leverPosting("emea", SENIOR + " II", { location: "Remote - EMEA", country: "DE" }),
    );
    const stats = await poll();

    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.chatId).toBe("1001");
    expect(t.telegram.sends[0]!.html).toContain("Senior Backend Engineer");
    expect(t.telegram.sends[0]!.html).toContain("Acme");
    const rows = await jobRows();
    expect(rows.find((r) => r.board_job_id === "new")).toMatchObject({
      status: "sent",
      telegram_message_id: 500,
      location_class: "us",
    });
    expect(await jobStatus("staff")).toBe("seen");
    expect(await jobStatus("emea")).toBe("seen");
    expect(stats).toMatchObject({ newJobs: 3, matched: 1, sent: 1, sendFailures: 0 });

    const settings = await t.store.getSettings();
    expect(settings.lastPollStartAt).toBe(t.clock.now - HOUR);
    expect(settings.lastSuccessfulPollAt).toBe(t.clock.now - HOUR);
    expect(settings.lastPollStats).toMatchObject({ companiesOk: 1, sent: 1 });
  });

  it("flags an ambiguous location with a warning", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme.push(leverPosting("r", SENIOR, { location: "Remote", country: "" }));
    await poll();
    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toContain("⚠️ Location doesn't say US");
  });

  it("does not re-send a known job whose title changed (AE6)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme = [leverPosting("j1", SENIOR)];
    await poll();
    expect(t.telegram.sends).toHaveLength(1);

    boards.lever.acme = [leverPosting("j1", "Senior Software Engineer, Payments")];
    await poll();

    expect(t.telegram.sends).toHaveLength(1);
    expect(await jobRows()).toEqual([expect.objectContaining({ board_job_id: "j1", title: SENIOR, status: "sent" })]);
  });

  it("excludes a Lever job at detection when its description has an excluded word (AE4)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await t.store.addExcludedWord("clearance");
    await poll();

    boards.lever.acme.push(leverPosting("sec", SENIOR, { description: "An active security clearance required." }));
    const stats = await poll();

    expect(await jobStatus("sec")).toBe("excluded");
    expect(t.telegram.sends).toEqual([]);
    expect(stats.matched).toBe(0);
  });

  it("suppresses matches while paused and sends only later jobs after resume (AE5)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    await t.store.pause();
    boards.lever.acme.push(leverPosting("p1", SENIOR));
    await poll();
    expect(await jobStatus("p1")).toBe("suppressed");
    expect(t.telegram.sends).toEqual([]);

    await t.store.resume();
    await poll();
    expect(t.telegram.sends).toEqual([]);

    boards.lever.acme.push(leverPosting("p2", "Senior Frontend Engineer"));
    await poll();
    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toContain("Senior Frontend Engineer");
    expect(await jobStatus("p1")).toBe("suppressed");
    expect(await jobStatus("p2")).toBe("sent");
  });

  it("marks a repost as duplicate but sends a coexisting same-title opening", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme = [leverPosting("a1", SENIOR)];
    await poll();
    expect(t.telegram.sends).toHaveLength(1);

    // a1 is still listed, so a2 is a second opening, not a repost.
    boards.lever.acme = [leverPosting("a1", SENIOR), leverPosting("a2", SENIOR)];
    await poll();
    expect(await jobStatus("a2")).toBe("sent");
    expect(t.telegram.sends).toHaveLength(2);

    // a1 and a2 disappear and a3 appears with the same title and location: a repost.
    boards.lever.acme = [leverPosting("a3", SENIOR)];
    await poll();
    expect(await jobStatus("a3")).toBe("duplicate");
    expect(t.telegram.sends).toHaveLength(2);
  });

  it("sends both of two same-title jobs that appear in one run", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme = [leverPosting("b1", SENIOR), leverPosting("b2", SENIOR)];
    await poll();
    expect(t.telegram.sends).toHaveLength(2);
    expect(t.sleeps).toEqual([1100]);
  });
});

describe("failures", () => {
  it("isolates a board timeout to that company", async () => {
    boards.lever.acme = [];
    boards.lever.slow = [];
    boards.greenhouse.globex = [];
    const acme = await addCompany(t.store, "Acme", "lever", "acme");
    const slow = await addCompany(t.store, "Slow", "lever", "slow");
    const globex = await addCompany(t.store, "Globex", "greenhouse", "globex");
    await poll();

    boards.timeout.add("slow");
    boards.lever.acme.push(leverPosting("n1", SENIOR));
    const stats = await poll();

    expect(stats).toMatchObject({ companiesOk: 2, companiesFailed: 1, sent: 1 });
    expect(await companyRow(slow)).toMatchObject({ state: "active", consecutive_failures: 1 });
    expect((await companyRow(slow))!.last_error).toMatch(/timed out/i);
    expect(await companyRow(acme)).toMatchObject({ consecutive_failures: 0 });
    expect(await companyRow(globex)).toMatchObject({ consecutive_failures: 0 });
    expect((await t.store.getSettings()).lastSuccessfulPollAt).toBe(t.clock.now - HOUR);
  });

  it("does not record a successful poll when every company fails", async () => {
    boards.timeout.add("acme");
    await addCompany(t.store, "Acme", "lever", "acme");
    const stats = await poll();
    expect(stats).toMatchObject({ companiesOk: 0, companiesFailed: 1 });
    const settings = await t.store.getSettings();
    expect(settings.lastSuccessfulPollAt).toBeUndefined();
    expect(settings.lastPollStartAt).toBe(t.clock.now - HOUR);
    expect(settings.lastPollStats).toMatchObject({ companiesFailed: 1 });
  });
});

describe("pending_validation companies", () => {
  it("validates, baselines and activates a Lever board, then confirms", async () => {
    boards.lever.acme = [leverPosting("v1", SENIOR), leverPosting("v2", "Senior iOS Engineer")];
    const id = await addCompany(t.store, "Acme", "lever", "acme", { state: "pending_validation" });

    await poll();

    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toBe(
      "✅ Added Acme (Lever, 2 open jobs). New matching roles will be sent from the next check.",
    );
    expect(await companyRow(id)).toMatchObject({ state: "active", baselined: 1 });
    expect((await jobRows()).map((r) => r.status)).toEqual(["seen", "seen"]);

    boards.lever.acme.push(leverPosting("v3", "Senior Web Developer"));
    await poll();
    expect(t.telegram.sends).toHaveLength(2);
    expect(t.telegram.sends[1]!.html).toContain("Senior Web Developer");
  });

  it("makes an unreachable board inactive and explains why", async () => {
    const id = await addCompany(t.store, "Nope <Co>", "lever", "nope", { state: "pending_validation" });

    await poll();

    expect(t.telegram.sends).toHaveLength(1);
    expect(t.telegram.sends[0]!.html).toBe('❌ Couldn\'t add Nope &lt;Co&gt;: board not found (Lever "nope").');
    expect(await companyRow(id)).toMatchObject({ state: "inactive", consecutive_failures: 1, baselined: 0 });

    await poll();
    expect(t.telegram.sends).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("mapPool keeps order and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  it("redactError strips bot tokens and caps length", () => {
    expect(redactError("fail https://api.telegram.org/bot123:ABC-def/sendMessage")).not.toContain("123:ABC");
    expect(redactError("x".repeat(1000))).toHaveLength(200);
  });

  it("uses greenhouse boards too", async () => {
    boards.greenhouse.globex = [greenhouseJob(1, SENIOR)];
    await addCompany(t.store, "Globex", "greenhouse", "globex");
    await poll();
    expect(await jobStatus("1")).toBe("seen");
  });
});
