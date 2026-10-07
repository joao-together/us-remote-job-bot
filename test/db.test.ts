import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REPOST_WINDOW_MS } from "../src/core/config";
import { Store, parseSeenIds, type NewJob, type PollStats } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

let clock = T0;
let store: Store;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM jobs"), env.DB.prepare("DELETE FROM companies"), env.DB.prepare("DELETE FROM settings")]);
  clock = T0;
  store = new Store(bindingDriver(env.DB), () => clock);
});

async function addCompany(name = "Acme", token = "acme", state: "active" | "pending_validation" = "active") {
  const { company } = await store.insertCompany({ name, ats: "lever", boardToken: token, state });
  return company.id;
}

function job(companyId: number, boardJobId: string, overrides: Partial<NewJob> = {}): NewJob {
  return {
    companyId,
    boardJobId,
    title: "Senior Software Engineer",
    normalizedTitle: "senior software engineer",
    locationText: "Remote - US",
    locationClass: "us",
    applyUrl: `https://jobs.lever.co/acme/${boardJobId}`,
    status: "pending",
    ...overrides,
  };
}

async function sendJob(jobId: number, messageId = 100, at = clock) {
  expect(await store.markSending(jobId)).toBe(true);
  await store.markSent(jobId, messageId, at);
}

describe("jobs", () => {
  it("keeps one row when the same company and board job id is inserted twice", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "j1")), store.stmtInsertJob(job(c, "j1", { title: "Senior Software Engineer (edited)" }))]);
    await store.runBatch([store.stmtInsertJob(job(c, "j1", { status: "seen" }))]);
    const rows = await env.DB.prepare("SELECT title, status FROM jobs").all();
    expect(rows.results).toEqual([{ title: "Senior Software Engineer", status: "pending" }]);
  });

  it("stores the location class and reason given at detection", async () => {
    const c = await addCompany();
    await store.runBatch([
      store.stmtInsertJob(job(c, "r", { locationClass: "us_restricted", locationReason: "Limited to some US states: CA, NY" })),
      store.stmtInsertJob(job(c, "u")),
    ]);
    const [restricted, us] = await store.listPending();
    expect(restricted).toMatchObject({ locationClass: "us_restricted", locationReason: "Limited to some US states: CA, NY" });
    expect(us).toMatchObject({ locationClass: "us", locationReason: null });
  });

  it("loads known job ids per company", async () => {
    const a = await addCompany("A", "a");
    const b = await addCompany("B", "b");
    const empty = await addCompany("C", "c");
    await store.runBatch([store.stmtInsertJob(job(a, "1")), store.stmtInsertJob(job(a, "2")), store.stmtInsertJob(job(b, "3"))]);
    const known = await store.knownJobIds([a, b, empty]);
    expect([...known.get(a)!].sort()).toEqual(["1", "2"]);
    expect([...known.get(b)!]).toEqual(["3"]);
    expect(known.get(empty)!.size).toBe(0);
  });

  it("lists keys of jobs that went through matching, excluding legacy seen rows", async () => {
    const a = await addCompany("A", "a");
    await store.runBatch([
      store.stmtInsertJob(job(a, "p", { status: "pending" })),
      store.stmtInsertJob(job(a, "x", { status: "excluded" })),
      store.stmtInsertJob(job(a, "s", { status: "seen" })),
    ]);
    expect([...(await store.matchedJobKeys())].sort()).toEqual([`${a}:p`, `${a}:x`]);
  });

  it("chunks large batches", async () => {
    const c = await addCompany();
    const stmts = Array.from({ length: 120 }, (_, i) => store.stmtInsertJob(job(c, `j${i}`, { status: "seen" })));
    await store.runBatch(stmts);
    const known = await store.knownJobIds([c]);
    expect(known.get(c)!.size).toBe(120);
  });
});

describe("repost guard", () => {
  it("returns sent/pending jobs first seen within the window as candidates", async () => {
    const c = await addCompany();
    await store.runBatch([
      store.stmtInsertJob(job(c, "seen-one", { status: "seen" })),
      store.stmtInsertJob(job(c, "excluded-one", { status: "excluded" })),
      store.stmtInsertJob(job(c, "old")),
    ]);
    const old = (await store.listPending())[0]!;
    await sendJob(old.id);

    const candidate = { companyId: c, boardJobId: "old", normalizedTitle: "senior software engineer", locationText: "Remote - US" };
    expect((await store.repostCandidates([c], T0 + 3600_000)).get(c)).toEqual([candidate]);
    expect((await store.repostCandidates([c], T0 + REPOST_WINDOW_MS)).get(c)).toEqual([candidate]);
    expect((await store.repostCandidates([c], T0 + REPOST_WINDOW_MS + 1)).get(c)).toBeUndefined();
  });

  it("returns batched repost candidates per company", async () => {
    const a = await addCompany("A", "a");
    const b = await addCompany("B", "b");
    await store.runBatch([
      store.stmtInsertJob(job(a, "1")),
      store.stmtInsertJob(job(a, "2", { status: "seen" })),
      store.stmtInsertJob(job(b, "3", { status: "excluded" })),
    ]);
    const map = await store.repostCandidates([a, b], T0 + 1000);
    expect(map.get(a)).toEqual([
      { companyId: a, boardJobId: "1", normalizedTitle: "senior software engineer", locationText: "Remote - US" },
    ]);
    expect(map.get(b)).toBeUndefined();
  });
});

describe("pause", () => {
  it("moves all pending jobs to suppressed and sets paused", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1")), store.stmtInsertJob(job(c, "2")), store.stmtInsertJob(job(c, "3"))]);
    await store.pause();
    expect(await store.listPending()).toHaveLength(0);
    const suppressed = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'suppressed'").first<{ n: number }>();
    expect(suppressed?.n).toBe(3);
    expect((await store.getSettings()).paused).toBe(true);

    await store.resume();
    expect((await store.getSettings()).paused).toBe(false);
    expect(await store.listPending()).toHaveLength(0);
  });
});

describe("delivery", () => {
  it("never returns a job left in sending as deliverable", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1")), store.stmtInsertJob(job(c, "2"))]);
    const [first] = await store.listPending();
    expect(await store.markSending(first!.id)).toBe(true);
    const pending = await store.listPending();
    expect(pending.map((j) => j.boardJobId)).toEqual(["2"]);
  });

  it("markSending is idempotent under retry but never claims a finished job (#11)", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1")), store.stmtInsertJob(job(c, "2"))]);
    const [first, second] = await store.listPending();
    // An HTTP retry of an already-applied UPDATE must still report success.
    expect(await store.markSending(first!.id)).toBe(true);
    expect(await store.markSending(first!.id)).toBe(true);
    expect((await store.getJob(first!.id))?.status).toBe("sending");
    // listPending still never hands a 'sending' row back to deliver().
    expect((await store.listPending()).map((j) => j.boardJobId)).toEqual(["2"]);

    await sendJob(second!.id);
    expect(await store.markSending(second!.id)).toBe(false);
    expect((await store.getJob(second!.id))?.status).toBe("sent");
  });

  it("markGone retires only pending jobs as seen (#7)", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1")), store.stmtInsertJob(job(c, "2"))]);
    const [a, b] = await store.listPending();
    await sendJob(b!.id);
    await store.markGone(a!.id);
    await store.markGone(b!.id);
    expect((await store.getJob(a!.id))?.status).toBe("seen");
    expect((await store.getJob(b!.id))?.status).toBe("sent");
    expect(await store.listPending()).toEqual([]);
  });

  it("lists pending oldest first with company info, and marks sent", async () => {
    const c = await addCompany("Acme Corp", "acme");
    clock = T0 + 10;
    await store.runBatch([store.stmtInsertJob(job(c, "newer"))]);
    clock = T0;
    await store.runBatch([store.stmtInsertJob(job(c, "older"))]);
    const pending = await store.listPending();
    expect(pending.map((j) => j.boardJobId)).toEqual(["older", "newer"]);
    expect(pending[0]).toMatchObject({ companyName: "Acme Corp", ats: "lever", boardToken: "acme" });
    expect(await store.listPending(1)).toHaveLength(1);

    await sendJob(pending[0]!.id, 555, T0 + 5);
    const sent = await store.getJob(pending[0]!.id);
    expect(sent).toMatchObject({ status: "sent", telegramMessageId: 555, sentAt: T0 + 5 });
  });

  it("marks excluded and updates salary detail", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1")), store.stmtInsertJob(job(c, "2"))]);
    const [a, b] = await store.listPending();
    await store.markExcluded(a!.id);
    await store.updateJobDetail(b!.id, { salaryText: "$180k - $220k" });
    expect((await store.getJob(a!.id))?.status).toBe("excluded");
    expect((await store.getJob(b!.id))?.salaryText).toBe("$180k - $220k");
  });
});

describe("user actions", () => {
  it("records applied only on sent jobs and allows switching", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1")), store.stmtInsertJob(job(c, "2"))]);
    const [a, b] = await store.listPending();
    await sendJob(a!.id);

    expect(await store.setUserAction(b!.id, "applied", T0)).toBeNull();
    expect(await store.setUserAction(a!.id, "applied", T0 + 1)).toMatchObject({ userAction: "applied", actionAt: T0 + 1 });
    expect(await store.setUserAction(a!.id, "applied", T0 + 2)).toMatchObject({ userAction: "applied", actionAt: T0 + 1 });
    expect(await store.setUserAction(a!.id, "skipped", T0 + 3)).toMatchObject({ userAction: "skipped", actionAt: T0 + 3 });
    expect(await store.setUserAction(a!.id, "applied", T0 + 4)).toMatchObject({ userAction: "applied", actionAt: T0 + 4 });
  });

  it("lists only applied jobs, newest first", async () => {
    const c = await addCompany("Acme", "acme");
    await store.runBatch(["1", "2", "3"].map((id) => store.stmtInsertJob(job(c, id))));
    const [j1, j2, j3] = await store.listPending();
    for (const j of [j1!, j2!, j3!]) await sendJob(j.id);
    await store.setUserAction(j1!.id, "applied", T0 + 100);
    await store.setUserAction(j2!.id, "skipped", T0 + 200);
    await store.setUserAction(j3!.id, "applied", T0 + 300);

    const applied = await store.listApplied();
    expect(applied.map((j) => j.boardJobId)).toEqual(["3", "1"]);
    expect(applied[0]).toMatchObject({ companyName: "Acme", applyUrl: "https://jobs.lever.co/acme/3" });
  });
});

describe("companies", () => {
  it("adds, reports existing, and reactivates inactive companies", async () => {
    const first = await store.insertCompany({ name: "Acme", ats: "lever", boardToken: "acme" });
    expect(first.status).toBe("added");
    expect(first.company.state).toBe("pending_validation");

    const again = await store.insertCompany({ name: "Acme Inc", ats: "lever", boardToken: "acme" });
    expect(again.status).toBe("exists");
    expect(again.company.id).toBe(first.company.id);

    await store.setCompanyState(first.company.id, "inactive");
    const back = await store.insertCompany({ name: "Acme", ats: "lever", boardToken: "acme" });
    expect(back.status).toBe("reactivated");
    expect(back.company.state).toBe("pending_validation");

    const other = await store.insertCompany({ name: "Acme", ats: "greenhouse", boardToken: "acme" });
    expect(other.status).toBe("added");
  });

  it("treats board tokens case-insensitively (#12)", async () => {
    const first = await store.insertCompany({ name: "Acme", ats: "lever", boardToken: "acme" });
    const again = await store.insertCompany({ name: "Acme", ats: "lever", boardToken: "Acme" });
    expect(again.status).toBe("exists");
    expect(again.company.id).toBe(first.company.id);
    expect((await store.findCompaniesByName("ACME")).map((c) => c.id)).toEqual([first.company.id]);
    // The unique index itself ignores case, so a raw insert conflicts too.
    await expect(
      env.DB.prepare("INSERT INTO companies (name, ats, board_token, created_at) VALUES ('X', 'lever', 'ACME', 0)").run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("never undoes a concurrent /remove when a validation result is written (#10)", async () => {
    const ok = await addCompany("A", "a", "pending_validation");
    const bad = await addCompany("B", "b", "pending_validation");
    // /remove lands while the poller is still fetching both boards.
    await store.setCompanyState(ok, "inactive");
    await store.setCompanyState(bad, "inactive");
    await store.runBatch([
      store.stmtCompanySuccess(ok, { baselined: true, state: "active" }),
      store.stmtCompanyFailure(bad, "not found", { state: "inactive" }),
    ]);
    expect(await store.getCompany(ok)).toMatchObject({ state: "inactive", baselined: true, consecutiveFailures: 0 });
    expect(await store.getCompany(bad)).toMatchObject({ state: "inactive", consecutiveFailures: 1 });

    // A still-pending company is activated as before.
    const fresh = await addCompany("C", "c", "pending_validation");
    await store.runBatch([store.stmtCompanySuccess(fresh, { baselined: true, state: "active" })]);
    expect((await store.getCompany(fresh))?.state).toBe("active");
  });

  it("stores seen ids compactly and tolerates malformed values", async () => {
    const id = await addCompany();
    expect((await store.getCompany(id))!.seenIds).toEqual([]);
    await store.runBatch([store.stmtCompanySuccess(id, { seenIds: ["a", "b"] })]);
    expect((await store.getCompany(id))!.seenIds).toEqual(["a", "b"]);
    expect(parseSeenIds("not json")).toEqual([]);
    expect(parseSeenIds('{"a":1}')).toEqual([]);
    expect(parseSeenIds(null)).toEqual([]);
    expect(parseSeenIds('["x", 7, null, "x"]')).toEqual(["x", "7"]);
  });

  it("finds companies by name or board token, case-insensitively", async () => {
    const id = await addCompany("Acme Corp", "acmecorp");
    expect((await store.findCompaniesByName("acme corp")).map((c) => c.id)).toEqual([id]);
    expect((await store.findCompaniesByName("ACMECORP")).map((c) => c.id)).toEqual([id]);
    expect(await store.findCompaniesByName("other")).toEqual([]);
  });

  it("lists poll companies and tracks success and failure", async () => {
    const active = await addCompany("A", "a", "active");
    const pending = await addCompany("B", "b", "pending_validation");
    const gone = await addCompany("C", "c", "active");
    await store.setCompanyState(gone, "inactive");
    expect((await store.listCompaniesForPoll()).map((c) => c.id)).toEqual([active, pending]);

    await store.runBatch([
      store.stmtCompanyFailure(active, "HTTP 500"),
      store.stmtCompanyFailure(active, "HTTP 500"),
      store.stmtCompanyFailure(active, "timeout"),
      store.stmtCompanySuccess(pending, { baselined: true, state: "active" }),
    ]);
    const failing = await store.failingCompanies();
    expect(failing.map((c) => c.id)).toEqual([active]);
    expect(failing[0]).toMatchObject({ consecutiveFailures: 3, lastError: "timeout", failing: true });
    const ok = await store.getCompany(pending);
    expect(ok).toMatchObject({ state: "active", baselined: true, consecutiveFailures: 0, failing: false });

    const listed = await store.listCompanies();
    expect(listed.map((c) => [c.name, c.failing])).toEqual([
      ["A", true],
      ["B", false],
    ]);

    await store.runBatch([store.stmtCompanySuccess(active)]);
    expect(await store.failingCompanies()).toEqual([]);
  });
});

describe("settings and status", () => {
  it("has defaults and round-trips values", async () => {
    const stats: PollStats = { companiesOk: 3, companiesFailed: 1, newJobs: 4, matched: 2, sent: 2, sendFailures: 0 };
    expect(await store.getSettings()).toEqual({
      paused: false,
      excludedWords: [],
      lastPollStartAt: undefined,
      lastSuccessfulPollAt: undefined,
      lastPollStats: undefined,
      lastWarningAt: undefined,
    });
    await store.runBatch([
      store.stmtSetSetting("last_poll_start_at", T0),
      store.stmtSetSetting("last_successful_poll_at", T0 + 5),
      store.stmtSetSetting("last_poll_stats", stats),
    ]);
    await store.setSetting("last_warning_at", T0 + 9);
    expect(await store.getSettings()).toMatchObject({
      lastPollStartAt: T0,
      lastSuccessfulPollAt: T0 + 5,
      lastPollStats: stats,
      lastWarningAt: T0 + 9,
    });
  });

  it("reads the paused flag on its own", async () => {
    expect(await store.isPaused()).toBe(false);
    await store.pause();
    expect(await store.isPaused()).toBe(true);
    await store.resume();
    expect(await store.isPaused()).toBe(false);
  });

  it("dedupes excluded words and removes them", async () => {
    expect(await store.addExcludedWord("clearance")).toEqual(["clearance"]);
    expect(await store.addExcludedWord("clearance")).toEqual(["clearance"]);
    expect(await store.addExcludedWord("crypto")).toEqual(["clearance", "crypto"]);
    expect(await store.removeExcludedWord("clearance")).toEqual(["crypto"]);
    expect(await store.removeExcludedWord("missing")).toEqual(["crypto"]);
    expect((await store.getSettings()).excludedWords).toEqual(["crypto"]);
  });

  it("counts status figures", async () => {
    const a = await addCompany("A", "a", "active");
    await addCompany("B", "b", "active");
    await addCompany("C", "c", "pending_validation");
    await store.runBatch(Array.from({ length: 3 }, () => store.stmtCompanyFailure(a, "x")));
    await store.runBatch(["1", "2", "3", "4"].map((id) => store.stmtInsertJob(job(a, id))));
    const [j1, j2] = await store.listPending();
    await sendJob(j1!.id, 1, T0);
    await sendJob(j2!.id, 2, T0 - 24 * 3600_000);

    expect(await store.statusCounts(Date.UTC(2026, 9, 6))).toEqual({
      sentToday: 1,
      active: 2,
      failing: 1,
      pendingValidation: 1,
      pending: 2,
    });
  });
});
