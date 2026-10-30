import { callbackDataOf } from "../src/core/telegram/format";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyLocation, type Country } from "../src/core/match/rules";
import { Store } from "../src/core/store/db";
import type { DbDriver, Statement } from "../src/core/store/driver";
import { TelegramError } from "../src/core/telegram/client";
import { normalizeParams } from "../src/core/util";
import { deliver, routeJob } from "../src/poller/deliver";
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
    expect(t.telegram.sends[0]!.markup?.inline_keyboard[0]?.map((b) => callbackDataOf(b)!)[0]).toMatch(/^a:\d+$/);
    const applyUrl = "https://job-boards.greenhouse.io/globex/jobs/12";
    expect(t.telegram.sends[0]!.markup?.inline_keyboard[1]).toEqual([
      { text: "📋 Copy link", copy_text: { text: applyUrl } },
      { text: "🌐 Open", url: applyUrl },
    ]);
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
    expect(stats).toEqual({ sent: 0, messagesSent: 0, excluded: 0, detailFailures: 0, gone: 0, sendFailures: 0, unrouted: 0 });
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

describe("country routing", () => {
  const OWNER = "1001";
  const ALICE = "3003";
  const BOB = "4004";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Pending Lever jobs for a baselined Acme (Lever has no detail fetch), with the given locations. */
  async function pendingAt(...jobs: [id: string, locationText: string, countryCodes?: string[]][]) {
    const companyId = await addCompany(t.store, "Acme", "lever", "acme", { baselined: true });
    await t.store.runBatch(
      jobs.map(([boardJobId, locationText, countryCodes = []], i) => {
        const loc = classifyLocation({ locationText, remote: "unknown", countryCodes });
        return t.store.stmtInsertJob(
          {
            companyId,
            boardJobId,
            title: `Senior Software Engineer ${boardJobId}`,
            normalizedTitle: `senior software engineer ${boardJobId}`,
            locationText,
            locationClass: loc.cls,
            locationReason: loc.reason ?? null,
            locationCountries: loc.countries ?? [],
            locationLatam: loc.latam ?? false,
            locationEmea: loc.emea ?? false,
            applyUrl: `https://jobs.lever.co/acme/${boardJobId}`,
            status: "pending",
          },
          t.clock.now + i,
        );
      }),
    );
  }

  const run = () => deliver({ ...t.deps, excludedWords: [] });
  const recipientsOf = (id: string) =>
    t.telegram.sends.filter((s) => s.html.includes(`Senior Software Engineer ${id}<`)).map((s) => String(s.chatId));
  async function deliveryUsers(boardJobId: string) {
    const res = await env.DB.prepare(
      "SELECT d.user_id FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE j.board_job_id = ? ORDER BY d.user_id",
    ).bind(boardJobId).all<{ user_id: string }>();
    return res.results.map((r) => r.user_id);
  }

  it("sends a Colombia job to the owner (all five by default) but not to a US-only member", async () => {
    await t.store.inviteUser(ALICE, 1);
    await t.store.setUserCountries(ALICE, ["US"]);
    await pendingAt(["co", "Remote - Colombia"], ["us", "Remote - US"]);

    const stats = await run();

    expect(stats).toMatchObject({ sent: 2, messagesSent: 3, unrouted: 0 });
    expect(recipientsOf("co")).toEqual([OWNER]);
    expect(recipientsOf("us")).toEqual([OWNER, ALICE]);
    expect(await deliveryUsers("co")).toEqual([OWNER]);
  });

  it("sends a LATAM-wide job to everyone with Mexico, Colombia or Argentina selected", async () => {
    await t.store.inviteUser(ALICE, 1);
    await t.store.inviteUser(BOB, 2);
    await t.store.setUserCountries(OWNER, ["US"]);
    await t.store.setUserCountries(ALICE, ["AR"]);
    await t.store.setUserCountries(BOB, ["US", "MX"]);
    await pendingAt(["latam", "Remote - LATAM"], ["mx", "Remote - Mexico"], ["ar", "Buenos Aires (Remote)"], ["usco", "Remote - US / Remote - Colombia"]);

    await run();

    expect(recipientsOf("latam")).toEqual([ALICE, BOB]);
    expect(recipientsOf("mx")).toEqual([BOB]);
    expect(recipientsOf("ar")).toEqual([ALICE]);
    expect(recipientsOf("usco")).toEqual([OWNER, BOB]);
    // The owner didn't get the LATAM job, so its owner message id is null.
    expect((await jobRows()).find((r) => r.board_job_id === "latam")).toMatchObject({ status: "sent", telegram_message_id: null });
  });

  it("sends UK and Europe/EMEA jobs to a UK-only member but not US jobs", async () => {
    await t.store.inviteUser(ALICE, 1);
    await t.store.inviteUser(BOB, 2);
    await t.store.setUserCountries(OWNER, ["US"]);
    await t.store.setUserCountries(ALICE, ["UK"]);
    await t.store.setUserCountries(BOB, ["MX", "UK"]);
    await pendingAt(
      ["uk", "London, UK (Remote)"],
      ["emea", "Remote - EMEA"],
      ["us", "Remote - US"],
      ["usuk", "Remote - US or UK"],
      ["mx", "Remote - Mexico"],
    );

    const stats = await run();

    expect(recipientsOf("uk")).toEqual([ALICE, BOB]);
    expect(recipientsOf("emea")).toEqual([ALICE, BOB]);
    expect(recipientsOf("us")).toEqual([OWNER]);
    expect(recipientsOf("usuk")).toEqual([OWNER, ALICE, BOB]);
    expect(recipientsOf("mx")).toEqual([BOB]);
    expect(stats).toMatchObject({ sent: 5, unrouted: 0 });
    const emea = t.telegram.sends.find((s) => s.html.includes("Senior Software Engineer emea<"))!;
    expect(emea.html.split("\n")[0]).toBe("🇪🇺 <b>EUROPE/EMEA REMOTE</b>");
    expect(emea.html).toContain("⚠️ Europe/EMEA — check UK is eligible");
    const uk = t.telegram.sends.find((s) => s.html.includes("Senior Software Engineer uk<"))!;
    expect(uk.html.split("\n")[0]).toBe("🇬🇧 <b>UK REMOTE</b>");
    const usuk = t.telegram.sends.find((s) => s.html.includes("Senior Software Engineer usuk<"))!;
    expect(usuk.html).toContain("Also open to: 🇬🇧 United Kingdom");
  });

  it("routes by routeCountries: Europe/EMEA counts as the UK, LATAM as MX/CO/AR", () => {
    const recipients = [
      { userId: "us", countries: ["US"] as Country[] },
      { userId: "uk", countries: ["UK"] as Country[] },
      { userId: "co", countries: ["CO"] as Country[] },
    ];
    expect(routeJob({ locationCountries: [], locationLatam: false, locationEmea: true }, recipients)).toEqual(["uk"]);
    expect(routeJob({ locationCountries: [], locationLatam: true, locationEmea: true }, recipients)).toEqual(["uk", "co"]);
    expect(routeJob({ locationCountries: ["US", "UK"], locationLatam: false, locationEmea: false }, recipients)).toEqual(["us", "uk"]);
    expect(routeJob({ locationCountries: ["UK"], locationLatam: false, locationEmea: false }, recipients)).toEqual(["uk"]);
    // No stored countries: treated as US-ambiguous.
    expect(routeJob({ locationCountries: [], locationLatam: false, locationEmea: false }, recipients)).toEqual(["us"]);
  });

  it("marks a job nobody selected as sent without sending, and never sends it later", async () => {
    await t.store.setUserCountries(OWNER, ["US"]);
    await pendingAt(["ar", "Remote - Argentina"], ["us", "Remote - US"]);

    const stats = await run();
    expect(stats).toMatchObject({ sent: 1, messagesSent: 1, unrouted: 1 });
    expect(recipientsOf("ar")).toEqual([]);
    expect(await jobStatus("ar")).toBe("sent");
    expect(await deliveryUsers("ar")).toEqual([]);

    // Selecting Argentina afterwards doesn't resend it.
    await t.store.setUserCountries(OWNER, ["US", "AR"]);
    t.telegram.sends.length = 0;
    expect(await run()).toMatchObject({ sent: 0, messagesSent: 0, unrouted: 0 });
    expect(t.telegram.sends).toEqual([]);
    expect(await jobStatus("ar")).toBe("sent");
  });

  it("doesn't let a member who blocked the bot hold up a job routed only to them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.store.inviteUser(ALICE, 1);
    await t.store.setUserCountries(OWNER, ["US"]);
    await t.store.setUserCountries(ALICE, ["CO"]);
    t.telegram.failFor.set(ALICE, new TelegramError("Forbidden: bot was blocked by the user", 403, "Forbidden: bot was blocked by the user"));
    await pendingAt(["co", "Remote - Colombia"], ["us", "Remote - US"]);

    const stats = await run();

    expect(stats).toMatchObject({ sent: 1, sendFailures: 1 });
    expect(await jobStatus("co")).toBe("sent");
    expect(await jobStatus("us")).toBe("sent");
    expect(recipientsOf("us")).toEqual([OWNER]);
  });

  it("still stops on an ambiguous failure of a member who is a job's first recipient", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.store.inviteUser(ALICE, 1);
    await t.store.setUserCountries(OWNER, ["US"]);
    await t.store.setUserCountries(ALICE, ["CO"]);
    await pendingAt(["co", "Remote - Colombia"], ["us", "Remote - US"]);
    t.telegram.failNext = true;

    expect(await run()).toMatchObject({ sent: 0, sendFailures: 1 });
    expect(await jobStatus("co")).toBe("sending");
    expect(await jobStatus("us")).toBe("pending");
  });

  it("reads recipients and their countries with one query per delivery run", async () => {
    await t.store.inviteUser(ALICE, 1);
    await t.store.inviteUser(BOB, 2);
    await t.store.setUserCountries(ALICE, ["CO"]);
    await pendingAt(["a", "Remote - US"], ["b", "Remote - Colombia"], ["c", "Remote - LATAM"]);
    const log: { sql: string; rowsRead: number }[] = [];
    const prep = (s: Statement) => env.DB.prepare(s.sql).bind(...normalizeParams(s.params));
    const driver: DbDriver = {
      async query<T = Record<string, unknown>>(s: Statement): Promise<T[]> {
        const res = await prep(s).all<T>();
        log.push({ sql: s.sql, rowsRead: res.meta.rows_read });
        return res.results;
      },
      async batch(stmts: Statement[]): Promise<void> {
        const res = await env.DB.batch(stmts.map(prep));
        stmts.forEach((s, i) => log.push({ sql: s.sql, rowsRead: res[i]!.meta.rows_read }));
      },
    };

    const stats = await deliver({ ...t.deps, store: new Store(driver, () => t.clock.now), excludedWords: [] });

    expect(stats).toMatchObject({ sent: 3, messagesSent: 8 });
    const prefReads = log.filter((q) => q.sql.includes("user_prefs"));
    expect(prefReads).toHaveLength(1);
    expect(prefReads[0]!.rowsRead).toBeLessThanOrEqual(10);
    expect(log.filter((q) => /FROM users/.test(q.sql))).toHaveLength(1);
  });
});
