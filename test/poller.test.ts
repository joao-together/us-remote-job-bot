import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BASELINE_COMPANIES_PER_RUN } from "../src/core/config";
import type { Fetcher } from "../src/core/ats/types";
import { mapPool, redactError, runPoll, selectForPoll } from "../src/poller/run";
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

async function seenIds(id: number): Promise<string[]> {
  const row = await env.DB.prepare("SELECT seen_ids FROM companies WHERE id = ?").bind(id).first<{ seen_ids: string }>();
  return JSON.parse(row!.seen_ids) as string[];
}

async function companyIdByToken(token: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM companies WHERE board_token = ?").bind(token).first<{ id: number }>();
  return row!.id;
}

async function poll() {
  const stats = await runPoll(t.deps);
  t.clock.now += HOUR;
  return stats;
}

describe("baseline", () => {
  it("records a seeded company's first fetch in seen_ids, creates no job rows and sends nothing", async () => {
    boards.lever.acme = [1, 2, 3, 4, 5].map((i) => leverPosting(`j${i}`, `${SENIOR} ${i}`));
    const id = await addCompany(t.store, "Acme", "lever", "acme");

    const stats = await poll();

    expect(t.telegram.sends).toEqual([]);
    expect(await jobRows()).toEqual([]);
    expect((await seenIds(id)).sort()).toEqual(["j1", "j2", "j3", "j4", "j5"]);
    expect(await companyRow(id)).toMatchObject({ state: "active", baselined: 1, consecutive_failures: 0 });
    expect(stats).toMatchObject({ companiesOk: 1, companiesFailed: 0, newJobs: 5, matched: 0, sent: 0 });
  });

  it("baselines a real-shaped board silently", async () => {
    boards.lever.spotify = leverFixture;
    const id = await addCompany(t.store, "Spotify", "lever", "spotify");
    await poll();
    expect(t.telegram.sends).toEqual([]);
    expect(await jobRows()).toEqual([]);
    expect((await seenIds(id)).sort()).toEqual([...new Set(leverFixture.map((p) => String(p.id)))].sort());
  });
});

describe("detection and delivery", () => {
  it("sends exactly one alert for one new matching job and records the message id", async () => {
    boards.lever.acme = [leverPosting("old", SENIOR)];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme.push(
      leverPosting("new", "Senior Backend Engineer"),
      leverPosting("junior", "Junior Software Engineer"),
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
    expect(await jobStatus("junior")).toBeUndefined();
    expect(await jobStatus("emea")).toBeUndefined();
    expect((await seenIds(await companyIdByToken("acme"))).sort()).toEqual(["emea", "junior", "old"]);
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

  it("applies a /pause or /exclude sent while boards are being fetched (#6)", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();

    boards.lever.acme.push(leverPosting("r1", SENIOR), leverPosting("r2", "Senior Software Engineer, Clearance Required"));
    const base = t.deps.fetcher;
    let fired = false;
    // The owner pauses and adds an excluded word while the run is mid-fetch.
    t.deps.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!fired) {
        fired = true;
        await t.store.addExcludedWord("clearance");
        await t.store.pause();
      }
      return base(input, init);
    }) as Fetcher;
    const stats = await poll();

    expect(fired).toBe(true);
    expect(await jobStatus("r1")).toBe("suppressed");
    expect(await jobStatus("r2")).toBe("excluded");
    expect(t.telegram.sends).toEqual([]);
    expect(stats.sent).toBe(0);
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

describe("compact seen ids", () => {
  it("adds a non-matching new job to seen_ids and inserts and sends a matching one", async () => {
    boards.lever.acme = [leverPosting("b1", SENIOR)];
    const id = await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    expect(await seenIds(id)).toEqual(["b1"]);

    boards.lever.acme.push(leverPosting("nm", "Office Manager"), leverPosting("m", "Senior Backend Engineer"));
    const stats = await poll();

    expect((await seenIds(id)).sort()).toEqual(["b1", "nm"]);
    expect(await jobRows()).toEqual([expect.objectContaining({ board_job_id: "m", status: "sent" })]);
    expect(t.telegram.sends).toHaveLength(1);
    expect(stats).toMatchObject({ newJobs: 2, matched: 1, sent: 1 });
  });

  it("does not re-classify an id in seen_ids and prunes ids that leave the board", async () => {
    boards.lever.acme = [leverPosting("s1", SENIOR), leverPosting("s2", SENIOR)];
    const id = await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    expect((await seenIds(id)).sort()).toEqual(["s1", "s2"]);

    // s1 now matches (company is baselined) but is known via seen_ids; s2 vanishes.
    boards.lever.acme = [leverPosting("s1", SENIOR)];
    const stats = await poll();

    expect(t.telegram.sends).toEqual([]);
    expect(await jobRows()).toEqual([]);
    expect(await seenIds(id)).toEqual(["s1"]);
    expect(stats).toMatchObject({ newJobs: 0, matched: 0 });
  });

  it("still treats legacy 'seen' job rows as known", async () => {
    boards.lever.acme = [];
    const id = await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    await env.DB.prepare(
      `INSERT INTO jobs (company_id, board_job_id, title, normalized_title, apply_url, status, first_seen_at)
       VALUES (?, 'legacy', ?, 'senior software engineer', 'https://x', 'seen', 0)`,
    )
      .bind(id, SENIOR)
      .run();

    boards.lever.acme = [leverPosting("legacy", SENIOR)];
    const stats = await poll();

    expect(t.telegram.sends).toEqual([]);
    expect(stats.newJobs).toBe(0);
    expect(await seenIds(id)).toEqual([]);
    expect(await jobRows()).toEqual([expect.objectContaining({ board_job_id: "legacy", status: "seen" })]);
  });

  it("writes nothing to the company row in a steady-state run", async () => {
    boards.lever.acme = [leverPosting("x1", "Office Manager"), leverPosting("x2", SENIOR)];
    const id = await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    const before = await seenIds(id);

    // Any company write would replace seen_ids and clear last_error; plant markers to detect one.
    await env.DB.prepare("UPDATE companies SET last_error = 'marker', seen_ids = ? WHERE id = ?")
      .bind(JSON.stringify(before), id)
      .run();
    const raw = async () =>
      (await env.DB.prepare("SELECT seen_ids, last_error FROM companies WHERE id = ?").bind(id).first())!;
    const snapshot = await raw();
    await poll();
    expect(await raw()).toEqual(snapshot);
    expect(snapshot.last_error).toBe("marker");
  });

  it("creates no job rows when baselining a board of 50 non-matching jobs", async () => {
    boards.lever.big = Array.from({ length: 50 }, (_, i) => leverPosting(`n${i}`, `Account Executive ${i}`));
    const id = await addCompany(t.store, "Big", "lever", "big");
    const stats = await poll();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(count!.n).toBe(0);
    expect(await seenIds(id)).toHaveLength(50);
    expect(stats.newJobs).toBe(50);
  });

  it("reads malformed seen_ids as empty", async () => {
    boards.lever.acme = [leverPosting("z1", "Office Manager")];
    const id = await addCompany(t.store, "Acme", "lever", "acme", { baselined: true });
    await env.DB.prepare("UPDATE companies SET seen_ids = 'not json' WHERE id = ?").bind(id).run();
    expect((await t.store.getCompany(id))!.seenIds).toEqual([]);
    await poll();
    expect(await seenIds(id)).toEqual(["z1"]);
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

  it("writes a healthy company's row only when its state changes", async () => {
    boards.lever.acme = [];
    const acme = await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    expect(await companyRow(acme)).toMatchObject({ baselined: 1, consecutive_failures: 0 });

    // A marker no success write would keep: proves the steady-state run skipped the company row.
    await env.DB.prepare("UPDATE companies SET last_error = 'marker' WHERE id = ?").bind(acme).run();
    await poll();
    expect((await companyRow(acme))!.last_error).toBe("marker");

    // After a failure, the next success clears the count and error.
    boards.timeout.add("acme");
    await poll();
    expect(await companyRow(acme)).toMatchObject({ consecutive_failures: 1 });
    boards.timeout.delete("acme");
    await poll();
    expect(await companyRow(acme)).toMatchObject({ consecutive_failures: 0, last_error: null });
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

describe("baseline rate limit (#9)", () => {
  async function addMany(n: number, opts: { baselined?: boolean } = {}) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const token = `co${String(i).padStart(3, "0")}`;
      boards.lever[token] = [leverPosting(`${token}-1`, SENIOR)];
      ids.push(await addCompany(t.store, `Co ${i}`, "lever", token, opts));
    }
    return ids;
  }

  async function baselinedIds() {
    const res = await env.DB.prepare("SELECT id FROM companies WHERE baselined = 1 ORDER BY id").all<{ id: number }>();
    return res.results.map((r) => r.id);
  }

  it("baselines at most BASELINE_COMPANIES_PER_RUN new companies per run, lowest ids first", async () => {
    expect(BASELINE_COMPANIES_PER_RUN).toBe(60);
    const ids = await addMany(70);

    const first = await poll();
    expect(first).toMatchObject({ companiesOk: 60, companiesFailed: 0, newJobs: 60 });
    expect(await baselinedIds()).toEqual(ids.slice(0, 60));
    expect(t.fetcher.requests).toHaveLength(60);
    const skipped = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.id = j.company_id WHERE c.baselined = 0").first<{ n: number }>();
    expect(skipped!.n).toBe(0);

    const second = await poll();
    expect(second).toMatchObject({ companiesOk: 70, companiesFailed: 0, newJobs: 10 });
    expect(await baselinedIds()).toEqual(ids);
    expect(t.telegram.sends).toEqual([]);
  });

  it("always processes pending_validation companies and baselined ones, even at the cap", async () => {
    boards.lever.old = [leverPosting("old-1", SENIOR)];
    const old = await addCompany(t.store, "Old", "lever", "old", { baselined: true });
    await addMany(60);
    boards.lever.added = [leverPosting("added-1", SENIOR)];
    const added = await addCompany(t.store, "Added", "lever", "added", { state: "pending_validation" });
    boards.lever.late = [leverPosting("late-1", SENIOR)];
    const late = await addCompany(t.store, "Late", "lever", "late");

    await poll();

    expect(await companyRow(added)).toMatchObject({ state: "active", baselined: 1 });
    expect(await companyRow(late)).toMatchObject({ baselined: 0, consecutive_failures: 0 });
    expect(await jobStatus("late-1")).toBeUndefined();
    expect(await jobStatus("old-1")).toBe("sent");
    expect(await baselinedIds()).toContain(old);
  });

  it("selectForPoll keeps validation and baselined companies outside the cap", () => {
    const mk = (id: number, state: "active" | "pending_validation", baselined: boolean) =>
      ({ id, state, baselined }) as Parameters<typeof selectForPoll>[0][number];
    const picked = selectForPoll(
      [mk(1, "active", false), mk(2, "pending_validation", false), mk(3, "active", true), mk(4, "active", false)],
      1,
    );
    expect(picked.map((c) => c.id)).toEqual([1, 2, 3]);
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
    expect(await jobRows()).toEqual([]);
    expect((await seenIds(id)).sort()).toEqual(["v1", "v2"]);

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

  it("still activates the company and records stats when the confirmation send fails", async () => {
    boards.lever.acme = [leverPosting("v1", SENIOR)];
    const id = await addCompany(t.store, "Acme", "lever", "acme", { state: "pending_validation" });
    t.telegram.failNext = true;

    await expect(runPoll(t.deps)).resolves.toBeDefined();

    expect(t.telegram.sends).toHaveLength(0);
    expect(await companyRow(id)).toMatchObject({ state: "active", baselined: 1 });
    const settings = await t.store.getSettings();
    expect(settings.lastPollStats).toBeDefined();
    expect(settings.lastPollStats).toMatchObject({ companiesOk: 1 });
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

  it("redactError strips bot tokens and known secrets and caps length", () => {
    expect(redactError("fail https://api.telegram.org/bot123:ABC-def/sendMessage")).toBe(
      "fail https://api.telegram.org/bot[redacted]/sendMessage",
    );
    expect(redactError("GET /x?token=abc&y=1")).toBe("GET /x?token=[redacted]&y=1");
    expect(redactError("auth s3cr3t failed", "s3cr3t", "")).toBe("auth [redacted] failed");
    expect(redactError("x".repeat(1000))).toHaveLength(200);
  });

  it("uses greenhouse boards too", async () => {
    boards.greenhouse.globex = [greenhouseJob(1, SENIOR)];
    const id = await addCompany(t.store, "Globex", "greenhouse", "globex");
    await poll();
    expect(await jobStatus("1")).toBeUndefined();
    expect(await seenIds(id)).toEqual(["1"]);
  });
});
