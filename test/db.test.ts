import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REPOST_WINDOW_MS } from "../src/core/config";
import { Store, parseSeenIds, type NewJob, type PollStats } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

let clock = T0;
let store: Store;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM access_requests"),
    env.DB.prepare("DELETE FROM jobs"), env.DB.prepare("DELETE FROM companies"), env.DB.prepare("DELETE FROM settings")]);
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

  it("re-queues a legacy seen row but leaves other statuses alone", async () => {
    const a = await addCompany("A", "a");
    await store.runBatch([
      store.stmtInsertJob(job(a, "old", { status: "seen", title: "Old" })),
      store.stmtInsertJob(job(a, "sent1", { status: "pending" })),
    ]);
    await store.markSent((await store.listPending())[0]!.id, 7, 1);
    await store.runBatch([
      store.stmtRequeueSeenJob(job(a, "old", { status: "pending", title: "Senior Software Engineer", locationClass: "us" })),
      store.stmtRequeueSeenJob(job(a, "sent1", { status: "pending" })),
    ]);
    const pending = await store.listPending();
    expect(pending.map((p) => [p.boardJobId, p.title, p.locationClass])).toEqual([["old", "Senior Software Engineer", "us"]]);
    expect([...(await store.matchedJobKeys())].sort()).toEqual([`${a}:old`, `${a}:sent1`]);
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

    expect(await store.setDeliveryAction(b!.id, "u1", "applied", T0)).toBeNull();
    expect(await store.setDeliveryAction(a!.id, "u1", "applied", T0 + 1)).toMatchObject({ userAction: "applied", actionAt: T0 + 1 });
    expect(await store.setDeliveryAction(a!.id, "u1", "applied", T0 + 2)).toMatchObject({ userAction: "applied", actionAt: T0 + 1 });
    expect(await store.setDeliveryAction(a!.id, "u1", "skipped", T0 + 3)).toMatchObject({ userAction: "skipped", actionAt: T0 + 3 });
    expect(await store.setDeliveryAction(a!.id, "u1", "applied", T0 + 4)).toMatchObject({ userAction: "applied", actionAt: T0 + 4 });
    // The legacy job-level columns are no longer written.
    expect(await store.getJob(a!.id)).toMatchObject({ userAction: null, actionAt: null });
  });

  it("keeps each user's action separate and keeps the recorded message id", async () => {
    const c = await addCompany();
    await store.runBatch([store.stmtInsertJob(job(c, "1"))]);
    const [a] = await store.listPending();
    await sendJob(a!.id, 100, T0);
    await store.recordDelivery(a!.id, "u2", 200, T0);

    await store.setDeliveryAction(a!.id, "u1", "applied", T0 + 1, 100);
    await store.setDeliveryAction(a!.id, "u2", "skipped", T0 + 2, 999);
    expect(await store.getDelivery(a!.id, "u1")).toEqual({
      jobId: a!.id, userId: "u1", telegramMessageId: 100, sentAt: T0, userAction: "applied", actionAt: T0 + 1,
    });
    // u2 already had a delivery row: its message id is kept, the action is set.
    expect(await store.getDelivery(a!.id, "u2")).toMatchObject({ telegramMessageId: 200, userAction: "skipped" });
  });

  it("lists only one user's applied jobs, newest first", async () => {
    const c = await addCompany("Acme", "acme");
    await store.runBatch(["1", "2", "3"].map((id) => store.stmtInsertJob(job(c, id))));
    const [j1, j2, j3] = await store.listPending();
    for (const j of [j1!, j2!, j3!]) await sendJob(j.id);
    await store.setDeliveryAction(j1!.id, "u1", "applied", T0 + 100);
    await store.setDeliveryAction(j2!.id, "u1", "skipped", T0 + 200);
    await store.setDeliveryAction(j3!.id, "u1", "applied", T0 + 300);
    await store.setDeliveryAction(j2!.id, "u2", "applied", T0 + 400);

    const applied = await store.listApplied("u1");
    expect(applied.map((j) => j.boardJobId)).toEqual(["3", "1"]);
    expect(applied[0]).toMatchObject({ companyName: "Acme", applyUrl: "https://jobs.lever.co/acme/3", actionAt: T0 + 300 });
    expect((await store.listApplied("u2")).map((j) => j.boardJobId)).toEqual(["2"]);
    expect(await store.listApplied("u3")).toEqual([]);
  });

  it("includes legacy job-level applied rows only when asked, unless overridden per user", async () => {
    const c = await addCompany("Acme", "acme");
    await store.runBatch(["1", "2", "3"].map((id) => store.stmtInsertJob(job(c, id))));
    const [j1, j2, j3] = await store.listPending();
    for (const j of [j1!, j2!, j3!]) await sendJob(j.id);
    // Applied before per-user deliveries existed.
    await env.DB.prepare("UPDATE jobs SET user_action = 'applied', action_at = ? WHERE id IN (?, ?)").bind(T0 + 50, j1!.id, j2!.id).run();
    await store.setDeliveryAction(j2!.id, "owner", "skipped", T0 + 60);
    await store.setDeliveryAction(j3!.id, "owner", "applied", T0 + 70);

    expect((await store.listApplied("owner", 20, { includeLegacy: true })).map((j) => [j.boardJobId, j.actionAt])).toEqual([
      ["3", T0 + 70],
      ["1", T0 + 50],
    ]);
    expect((await store.listApplied("owner")).map((j) => j.boardJobId)).toEqual(["3"]);
    expect(await store.listApplied("member", 20, { includeLegacy: false })).toEqual([]);
    expect(await store.listApplied("owner", 1, { includeLegacy: true })).toHaveLength(1);
  });
});

describe("users", () => {
  it("lists recipients with the owner first and only active users", async () => {
    expect(await store.listRecipients("1001")).toEqual(["1001"]);
    clock = T0 + 1;
    await store.inviteUser("300");
    clock = T0 + 2;
    await store.inviteUser("200");
    await store.inviteUser("400");
    await store.revokeUser("400");
    expect(await store.listRecipients("1001")).toEqual(["1001", "300", "200"]);
    expect(await store.countActiveUsers()).toBe(2);
    expect(await store.isActiveUser("300")).toBe(true);
    expect(await store.isActiveUser("400")).toBe(false);
  });

  it("invites with the access request's name, reports existing, and reactivates", async () => {
    expect(await store.recordAccessRequest("500", "Jane (@jane)", T0)).toBe(true);
    expect(await store.recordAccessRequest("500", "Other", T0 + 1)).toBe(false);

    expect(await store.inviteUser("500", T0 + 2)).toEqual({ status: "added", user: { userId: "500", name: "Jane (@jane)", active: true, addedAt: T0 + 2 } });
    expect((await store.inviteUser("500", T0 + 3)).status).toBe("exists");
    expect(await store.revokeUser("500")).toMatchObject({ userId: "500", active: false });
    expect(await store.revokeUser("500")).toBeNull();
    expect(await store.inviteUser("500", T0 + 4)).toMatchObject({ status: "reactivated", user: { active: true, name: "Jane (@jane)", addedAt: T0 + 4 } });
    expect(await store.inviteUser("600", T0 + 5)).toMatchObject({ status: "added", user: { name: null } });
    expect((await store.listUsers()).map((u) => u.userId)).toEqual(["500", "600"]);
  });
});

describe("companies", () => {
  it("inserts discovered companies as active and unbaselined, leaving existing boards alone", async () => {
    const old = await store.insertCompany({ name: "Acme", ats: "lever", boardToken: "acme" });
    await store.setCompanyState(old.company.id, "inactive");
    await store.runBatch([
      store.stmtInsertActiveCompany({ name: "Acme Renamed", ats: "lever", boardToken: "ACME" }),
      store.stmtInsertActiveCompany({ name: "Beta", ats: "ashby", boardToken: "beta" }),
      store.stmtInsertActiveCompany({ name: "Beta Again", ats: "ashby", boardToken: "beta" }),
    ]);
    const rows = await store.listCompanies({ includeInactive: true });
    expect(rows.map((c) => [c.name, c.state, c.baselined, c.seenIds])).toEqual([
      ["Acme", "inactive", false, []],
      ["Beta", "active", false, []],
    ]);
    expect(rows[1]!.createdAt).toBe(T0);
  });

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
