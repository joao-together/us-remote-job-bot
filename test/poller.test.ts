import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BASELINE_COMPANIES_PER_RUN, WIDE_SLOT_MS, WIDE_SLOTS } from "../src/core/config";
import type { Fetcher } from "../src/core/ats/types";
import { Store } from "../src/core/store/db";
import type { DbDriver, Statement } from "../src/core/store/driver";
import { normalizeParams } from "../src/core/util";
import { mapPool, redactError, runPoll, wideSlot } from "../src/poller/run";
import leverFixture from "./fixtures/lever/postings.json";
import {
  HOUR,
  T0,
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

  it("sends a remote-Mexico senior engineer job with the Mexico banner", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme.push(
      leverPosting("mx", SENIOR, { location: "Remote - Mexico", country: "MX" }),
      leverPosting("mxcity", "Senior Backend Engineer", { location: "Mexico City", country: "MX", workplaceType: "onsite" }),
    );
    await poll();
    expect(t.telegram.sends).toHaveLength(1);
    const html = t.telegram.sends[0]!.html;
    expect(html.split("\n")[0]).toBe("🇲🇽 <b>MEXICO REMOTE</b>");
    expect(html).toContain(`<b>${SENIOR}</b>`);
    expect(html).toContain("📍 Remote - Mexico");
    expect(html).not.toContain("⚠️");
    expect((await jobRows()).find((r) => r.board_job_id === "mx")).toMatchObject({ status: "sent", location_class: "mx" });
    expect(await jobStatus("mxcity")).toBeUndefined();
  });

  it("stores the other countries of a US job and shows them in the alert", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme.push(leverPosting("both", SENIOR, { location: "Remote - US / Remote - Mexico / Remote - Colombia", country: "US" }));
    await poll();
    expect(t.telegram.sends).toHaveLength(1);
    const html = t.telegram.sends[0]!.html;
    expect(html.split("\n")[0]).toBe(`<b>${SENIOR}</b>`);
    expect(html).toContain("Also open to: 🇲🇽 Mexico, 🇨🇴 Colombia");
    expect((await jobRows()).find((r) => r.board_job_id === "both")).toMatchObject({ location_class: "us+mx+co" });
  });

  it("sends Colombia, Argentina and LATAM-wide remote jobs with their banners", async () => {
    boards.lever.acme = [];
    await addCompany(t.store, "Acme", "lever", "acme");
    await poll();
    boards.lever.acme.push(
      leverPosting("co", SENIOR, { location: "Bogotá, Colombia (Remote)", country: "CO" }),
      leverPosting("ar", "Senior Backend Engineer", { location: "Buenos Aires (Remote)", country: "AR" }),
      leverPosting("latam", "Senior Frontend Engineer", { location: "Remote - LATAM", country: "" }),
      leverPosting("denver", "Senior Mobile Engineer", { location: "Denver, CO", country: "US" }),
    );
    await poll();
    expect(t.telegram.sends.map((s) => s.html.split("\n")[0])).toEqual([
      "🇨🇴 <b>COLOMBIA REMOTE</b>",
      "🇦🇷 <b>ARGENTINA REMOTE</b>",
      "🌎 <b>LATAM REMOTE</b>",
      "<b>Senior Mobile Engineer</b>",
    ]);
    expect(t.telegram.sends[2]!.html).toContain("⚠️ LATAM — check your country is eligible");
    const classes = Object.fromEntries((await jobRows()).map((r) => [r.board_job_id, r.location_class]));
    expect(classes).toMatchObject({ co: "intl+co", ar: "intl+ar", latam: "intl+latam", denver: "us" });
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

/** Inserts `n` lever companies in one batch (lever boards with one senior job each); ids in order. */
async function addMany(n: number, opts: { baselined?: boolean; tier?: "fast" | "wide"; prefix?: string } = {}) {
  const prefix = opts.prefix ?? "co";
  const tokens = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
  for (const token of tokens) boards.lever[token] = [leverPosting(`${token}-1`, SENIOR)];
  await env.DB.batch(
    tokens.map((token, i) =>
      env.DB.prepare(
        "INSERT INTO companies (name, ats, board_token, state, baselined, created_at, tier) VALUES (?, 'lever', ?, 'active', ?, ?, ?)",
      ).bind(`${prefix} ${i}`, token, opts.baselined ? 1 : 0, t.clock.now, opts.tier ?? "fast"),
    ),
  );
  const ids: number[] = [];
  for (const token of tokens) ids.push(await companyIdByToken(token));
  return ids;
}

/** Board tokens the poller fetched (Lever list requests), sorted. */
function fetchedTokens(): string[] {
  return t.fetcher.requests
    .map((r) => /api\.lever\.co\/v0\/postings\/([^/?]+)/.exec(r.url)?.[1])
    .filter((x): x is string => !!x)
    .sort();
}

const SLOT_MS = WIDE_SLOT_MS;
/** Time for the wide rotation to come back to the same group. */
const WIDE_CYCLE_MS = WIDE_SLOTS * SLOT_MS;

/** The first time at or after T0 whose wide slot is this company's. */
function slotTimeFor(id: number): number {
  return T0 + (((id % WIDE_SLOTS) - wideSlot(T0) + WIDE_SLOTS) % WIDE_SLOTS) * SLOT_MS;
}

describe("baseline rate limit (#9)", () => {
  async function baselinedIds() {
    const res = await env.DB.prepare("SELECT id FROM companies WHERE baselined = 1 ORDER BY id").all<{ id: number }>();
    return res.results.map((r) => r.id);
  }

  it("baselines at most BASELINE_COMPANIES_PER_RUN new companies per run, lowest ids first, any tier", async () => {
    expect(BASELINE_COMPANIES_PER_RUN).toBe(400);
    const fast = await addMany(205);
    const wide = await addMany(205, { tier: "wide", prefix: "wd" });
    const ids = [...fast, ...wide];

    const first = await poll();
    expect(first).toMatchObject({ companiesOk: 400, companiesFailed: 0, newJobs: 400 });
    expect(await baselinedIds()).toEqual(ids.slice(0, 400));
    expect(t.fetcher.requests).toHaveLength(400);
    const skipped = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.id = j.company_id WHERE c.baselined = 0",
    ).first<{ n: number }>();
    expect(skipped!.n).toBe(0);

    // Next run (same wide slot, an hour later): every fast company, the wide ones on this slot,
    // and the last 10 still waiting for their baseline.
    const second = await poll();
    expect(await baselinedIds()).toEqual(ids);
    const slot = wideSlot(t.clock.now - HOUR);
    const expected = [...fast, ...wide.filter((id, i) => i >= 195 || id % WIDE_SLOTS === slot)];
    expect(second).toMatchObject({ companiesOk: expected.length, companiesFailed: 0, newJobs: 10 });
    expect(t.telegram.sends).toEqual([]);
  });

  it("always processes pending_validation companies and baselined ones, even at the cap", async () => {
    boards.lever.old = [leverPosting("old-1", SENIOR)];
    const old = await addCompany(t.store, "Old", "lever", "old", { baselined: true });
    await addMany(BASELINE_COMPANIES_PER_RUN);
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
});

describe("tiers", () => {
  async function tierRow(id: number) {
    return env.DB.prepare("SELECT tier, last_match_at, seen_ids, last_error FROM companies WHERE id = ?")
      .bind(id)
      .first<{ tier: string; last_match_at: number | null; seen_ids: string; last_error: string | null }>();
  }

  it("wideSlot cycles through WIDE_SLOTS groups, one per WIDE_SLOT_MS", () => {
    const base = Math.floor(T0 / SLOT_MS) * SLOT_MS;
    const slots = Array.from({ length: 7 }, (_, i) => wideSlot(base + i * SLOT_MS));
    expect(new Set(slots.slice(0, 6)).size).toBe(6);
    expect(slots[6]).toBe(slots[0]);
    expect(wideSlot(base + 9 * 60_000)).toBe(slots[0]);
  });

  it("polls fast companies every run and each wide company only on its slot", async () => {
    const fast = await addMany(3, { baselined: true, prefix: "fa" });
    const wide = await addMany(12, { baselined: true, tier: "wide", prefix: "wd" });
    const tokenOf = (prefix: string, i: number) => `${prefix}${String(i).padStart(3, "0")}`;
    // Boards without matching roles, so no wide company is promoted during the test.
    for (const token of Object.keys(boards.lever)) boards.lever[token] = [leverPosting(`${token}-x`, "Office Manager")];
    const base = Math.floor(T0 / SLOT_MS) * SLOT_MS;
    const checks = new Map<number, number>();

    for (let run = 0; run < WIDE_SLOTS; run++) {
      t.clock.now = base + run * SLOT_MS;
      t.fetcher.requests.length = 0;
      await runPoll(t.deps);
      const slot = wideSlot(t.clock.now);
      const expected = [
        ...fast.map((_, i) => tokenOf("fa", i)),
        ...wide.flatMap((id, i) => (id % WIDE_SLOTS === slot ? [tokenOf("wd", i)] : [])),
      ].sort();
      expect(fetchedTokens()).toEqual(expected);
      for (const id of wide) if (id % WIDE_SLOTS === slot) checks.set(id, (checks.get(id) ?? 0) + 1);
    }
    // Over WIDE_SLOTS consecutive runs (one hour), every wide company is checked exactly once.
    expect([...checks.keys()].sort((a, b) => a - b)).toEqual(wide);
    expect([...checks.values()].every((n) => n === 1)).toBe(true);
  });

  it("promotes a wide company to fast on its first new match and records last_match_at", async () => {
    const [id] = await addMany(1, { baselined: true, tier: "wide", prefix: "wd" });
    const runAt = slotTimeFor(id!);
    t.clock.now = runAt;
    // Already baselined with empty seen_ids, so its open senior role is new and matches.
    await runPoll(t.deps);
    expect(await jobStatus("wd000-1")).toBe("sent");
    expect(await tierRow(id!)).toMatchObject({ tier: "fast", last_match_at: runAt });

    // Now fast: checked on the very next run, off its old slot.
    t.clock.now = runAt + SLOT_MS;
    expect(wideSlot(t.clock.now)).not.toBe(id! % WIDE_SLOTS);
    boards.lever.wd000!.push(leverPosting("wd000-2", "Senior Backend Engineer"));
    await runPoll(t.deps);
    expect(await jobStatus("wd000-2")).toBe("sent");
    expect(await tierRow(id!)).toMatchObject({ tier: "fast", last_match_at: runAt + SLOT_MS });
  });

  it("does not promote or set last_match_at for baseline or non-matching new jobs", async () => {
    const [id] = await addMany(1, { tier: "wide", prefix: "wd" });
    await poll(); // baseline: the matching wd000-1 is only recorded as seen
    expect(await tierRow(id!)).toMatchObject({ tier: "wide", last_match_at: null });

    t.clock.now = slotTimeFor(id!) + 2 * WIDE_CYCLE_MS;
    boards.lever.wd000!.push(leverPosting("x-1", "Office Manager"));
    await runPoll(t.deps);
    expect(JSON.parse((await tierRow(id!))!.seen_ids)).toContain("x-1");
    expect(await tierRow(id!)).toMatchObject({ tier: "wide", last_match_at: null });
  });

  it("writes nothing to a wide company's row when its board is unchanged", async () => {
    const [id] = await addMany(1, { baselined: true, tier: "wide", prefix: "wd" });
    boards.lever.wd000 = [leverPosting("x-1", "Office Manager")];
    t.clock.now = slotTimeFor(id!);
    await runPoll(t.deps);
    await env.DB.prepare("UPDATE companies SET last_error = 'marker' WHERE id = ?").bind(id).run();
    const snapshot = await tierRow(id!);
    t.clock.now += WIDE_CYCLE_MS;
    t.fetcher.requests.length = 0;
    await runPoll(t.deps);
    expect(fetchedTokens()).toEqual(["wd000"]);
    expect(await tierRow(id!)).toEqual(snapshot);
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

describe("D1 reads follow what changed (free plan: 5M rows read a day)", () => {
  interface Logged {
    sql: string;
    params: unknown[];
    rowsRead: number;
  }

  /** Deps whose store runs on a driver that logs every statement with D1's meta.rows_read. */
  function metered() {
    const log: Logged[] = [];
    const prep = (s: Statement) => env.DB.prepare(s.sql).bind(...normalizeParams(s.params));
    const driver: DbDriver = {
      async query<T = Record<string, unknown>>(s: Statement): Promise<T[]> {
        const res = await prep(s).all<T>();
        log.push({ sql: s.sql, params: s.params ?? [], rowsRead: res.meta.rows_read });
        return res.results;
      },
      async batch(stmts: Statement[]): Promise<void> {
        const res = await env.DB.batch(stmts.map(prep));
        stmts.forEach((s, i) => log.push({ sql: s.sql, params: s.params ?? [], rowsRead: res[i]!.meta.rows_read }));
      },
    };
    const deps = { ...t.deps, store: new Store(driver, () => t.clock.now) };
    return { log, deps, rowsRead: () => log.reduce((n, q) => n + q.rowsRead, 0) };
  }
  const storedLookups = (log: Logged[]) => log.filter((q) => q.sql.includes("json_each"));
  const repostLookups = (log: Logged[]) => log.filter((q) => q.sql.includes("jobs_repost_recent"));
  const jobsReads = (log: Logged[]) => log.filter((q) => /^\s*SELECT/i.test(q.sql) && /\bjobs\b/.test(q.sql));

  /** 60 baselined boards with a long history of sent jobs that are no longer listed. */
  async function steadyState() {
    const ids = await addMany(60, { prefix: "st" });
    await poll(); // baseline: every listed id goes to seen_ids
    await env.DB.batch(
      ids.flatMap((id) =>
        Array.from({ length: 20 }, (_, j) =>
          env.DB.prepare(
            `INSERT INTO jobs (company_id, board_job_id, title, normalized_title, apply_url, status, first_seen_at, sent_at)
             VALUES (?, ?, ?, 'senior software engineer', 'https://x', 'sent', ?, ?)`,
          ).bind(id, `gone-${id}-${j}`, SENIOR, t.clock.now - 2 * HOUR, t.clock.now - 2 * HOUR),
        ),
      ),
    );
    return ids;
  }

  it("reads nothing from jobs for lookups when no board lists an id outside its seen_ids", async () => {
    await steadyState();
    const m = metered();
    const stats = await runPoll(m.deps);

    expect(stats).toMatchObject({ companiesOk: 60, newJobs: 0 });
    expect(storedLookups(m.log)).toEqual([]);
    expect(repostLookups(m.log)).toEqual([]);
    // Only delivery's pending-jobs check touches jobs, and there is nothing pending.
    expect(jobsReads(m.log).reduce((n, q) => n + q.rowsRead, 0)).toBe(0);
    // The 60 polled company rows plus settings; the 1,200 stored jobs are never read.
    expect(m.rowsRead()).toBeLessThanOrEqual(60 + 20);
  });

  it("looks up only unseen ids and reads repost candidates only for boards with a new match", async () => {
    const [a, b, c] = await steadyState();
    // a: a new matching job; b: a new non-matching job; c: lists a job already stored (sent earlier).
    boards.lever.st000!.push(leverPosting("a-new", "Senior Backend Engineer"));
    boards.lever.st001!.push(leverPosting("b-new", "Office Manager"));
    boards.lever.st002!.push(leverPosting(`gone-${c}-0`, SENIOR));
    const m = metered();
    const stats = await runPoll(m.deps);

    expect(stats).toMatchObject({ newJobs: 2, matched: 1, sent: 1 });
    expect(await jobStatus("a-new")).toBe("sent");
    expect(await seenIds(b!)).toContain("b-new");
    const lookups = storedLookups(m.log);
    expect(lookups).toHaveLength(1);
    expect(JSON.parse(String(lookups[0]!.params[0]))).toEqual([
      [a, "a-new"],
      [b, "b-new"],
      [c, `gone-${c}-0`],
    ]);
    expect(lookups[0]!.rowsRead).toBeLessThanOrEqual(6);
    const reposts = repostLookups(m.log);
    expect(reposts).toHaveLength(1);
    expect(reposts[0]!.params.slice(0, -1)).toEqual([a]);
    // Company a's 20 recent sent jobs (its repost candidates), not all 1,200.
    expect(reposts[0]!.rowsRead).toBeLessThanOrEqual(25);
  });

  it("reads a baselining board's stored rows (usually none) instead of probing each of its ids", async () => {
    boards.lever.big = Array.from({ length: 200 }, (_, i) => leverPosting(`n${i}`, SENIOR));
    const id = await addCompany(t.store, "Big", "lever", "big");
    const m = metered();
    const stats = await runPoll(m.deps);

    expect(stats).toMatchObject({ newJobs: 200, matched: 0 });
    expect(await seenIds(id)).toHaveLength(200);
    expect(storedLookups(m.log)).toEqual([]);
    expect(repostLookups(m.log)).toEqual([]);
    const reads = jobsReads(m.log);
    expect(reads.map((q) => q.params)).toContainEqual([id]);
    expect(reads.reduce((n, q) => n + q.rowsRead, 0)).toBeLessThanOrEqual(2);
  });
});
