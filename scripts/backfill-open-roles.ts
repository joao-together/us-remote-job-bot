// Queues every currently open role that matches the filters (and has no job row yet) as pending,
// so the next poller run sends them as normal alerts. Run via the "Send open matching roles" workflow.
import { adapterFor } from "../src/core/ats/detect";
import { matchesTarget, normalizeTitle, findExcludedWord, prepareExcludedWords } from "../src/core/match/rules";
import { Store, type CompanyRow } from "../src/core/store/db";
import type { NormalizedJob } from "../src/core/ats/types";
import type { LocationResult } from "../src/core/match/rules";
import { httpDriver } from "../src/core/store/driver-http";

const store = new Store(httpDriver({ accountId: process.env.CF_ACCOUNT_ID!, databaseId: process.env.CF_D1_DATABASE_ID!, apiToken: process.env.CF_D1_API_TOKEN! }));
const dryRun = process.argv.includes("--dry-run");
const settings = await store.getSettings();
const excluded = prepareExcludedWords(settings.excludedWords);
const companies = (await store.listCompaniesForPoll()).filter((c) => c.state === "active");
const haveRow = await store.matchedJobKeys();
const found: { c: CompanyRow; j: NormalizedJob; loc: LocationResult }[] = [];
let failed = 0;
const queue = [...companies];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const c = queue.shift()!;
    let r = await adapterFor(c.ats).listJobs(c.boardToken, fetch);
    if (!r.ok) r = await adapterFor(c.ats).listJobs(c.boardToken, fetch);
    if (!r.ok) { failed++; continue; }
    for (const j of r.value) {
      const m = matchesTarget(j);
      if (!m.pass || haveRow.has(c.id + ":" + j.id)) continue;
      if (findExcludedWord(j.title + "\n" + (j.description ?? ""), excluded)) continue;
      found.push({ c, j, loc: m.location });
    }
  }
}));
found.sort((a, b) => (a.j.postedAt ?? 0) - (b.j.postedAt ?? 0));
console.log(`companies: ${companies.length}, fetch failures: ${failed}, matching roles to queue: ${found.length}`);
for (const f of found.slice(-8)) console.log("  newest:", f.j.title, "@", f.c.name, "|", f.j.locationText);
if (dryRun) process.exit(0);
const now = Date.now();
const stmts = found.map((f, i) => store.stmtInsertJob({ companyId: f.c.id, boardJobId: f.j.id, title: f.j.title, normalizedTitle: normalizeTitle(f.j.title), locationText: f.j.locationText, locationClass: f.loc.cls, locationReason: f.loc.reason ?? null, applyUrl: f.j.applyUrl, postedAt: f.j.postedAt ?? null, salaryText: f.j.salaryText ?? null, status: "pending" }, now + i));
await store.runBatch(stmts);
console.log("queued", stmts.length);
