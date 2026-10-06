import { adapterFor } from "../core/ats/detect";
import type { AtsKind, FetchFailure, Fetcher, NormalizedJob } from "../core/ats/types";
import { FETCH_CONCURRENCY } from "../core/config";
import { findExcludedWord, matchesTarget, normalizeTitle } from "../core/match/rules";
import type { Statement } from "../core/store/driver";
import type { CompanyRow, NewJob, RepostCandidate, Settings, Store } from "../core/store/db";
import { escapeHtml } from "../core/telegram/format";
import { deliver, type Sender } from "./deliver";

export interface PollDeps {
  store: Store;
  fetcher: Fetcher;
  telegram: Sender;
  ownerId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface PollStats {
  companiesOk: number;
  companiesFailed: number;
  /** New board job ids stored this run, in any status. */
  newJobs: number;
  /** New ids that matched and became pending or suppressed. */
  matched: number;
  sent: number;
  sendFailures: number;
  [key: string]: unknown;
}

const ATS_NAMES: Record<AtsKind, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
};

const FAILURE_TEXT: Record<FetchFailure["kind"], string> = {
  not_found: "board not found",
  timeout: "the board timed out",
  http_error: "the board returned an error",
  parse_error: "the board's response couldn't be read",
};

/** Short, secret-free error text for storage and messages. */
export function redactError(message: string): string {
  return message
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/(token|key|secret|authorization)=[^&\s]+/gi, "$1=<redacted>")
    .slice(0, 200);
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface CompanyOutcome {
  ok: boolean;
  statements: Statement[];
  newJobs: number;
  matched: number;
  ownerMessage?: string;
}

interface ClassifyContext {
  settings: Settings;
  known: Set<string>;
  candidates: RepostCandidate[];
  at: number;
}

function classifyNew(job: NormalizedJob, company: CompanyRow, baselining: boolean, onBoard: Set<string>, ctx: ClassifyContext): NewJob {
  const base = {
    companyId: company.id,
    boardJobId: job.id,
    title: job.title,
    normalizedTitle: normalizeTitle(job.title),
    locationText: job.locationText,
    applyUrl: job.applyUrl,
    postedAt: job.postedAt ?? null,
    salaryText: job.salaryText ?? null,
  };
  if (baselining) return { ...base, status: "seen" };

  const match = matchesTarget(job);
  if (!match.pass) return { ...base, status: "seen" };

  const isRepost = ctx.candidates.some(
    (c) => !onBoard.has(c.boardJobId) && c.normalizedTitle === base.normalizedTitle && c.locationText === base.locationText,
  );
  let status: NewJob["status"];
  if (isRepost) status = "duplicate";
  else if (findExcludedWord(`${job.title}\n${job.description ?? ""}`, ctx.settings.excludedWords)) status = "excluded";
  else if (ctx.settings.paused) status = "suppressed";
  else status = "pending";
  return { ...base, locationClass: match.location.cls, status };
}

async function pollCompany(company: CompanyRow, deps: PollDeps, ctx: ClassifyContext): Promise<CompanyOutcome> {
  const { store } = deps;
  const validating = company.state === "pending_validation";
  const res = await adapterFor(company.ats)
    .listJobs(company.boardToken, deps.fetcher)
    .catch((err: unknown): FetchFailure => ({ ok: false, kind: "parse_error", message: String(err) }));

  if (!res.ok) {
    const error = redactError(res.message);
    return {
      ok: false,
      statements: [store.stmtCompanyFailure(company.id, ctx.at, error, validating ? { state: "inactive" } : {})],
      newJobs: 0,
      matched: 0,
      ownerMessage: validating
        ? `❌ Couldn't add ${escapeHtml(company.name)}: ${FAILURE_TEXT[res.kind]} (${escapeHtml(ATS_NAMES[company.ats])} "${escapeHtml(company.boardToken)}").`
        : undefined,
    };
  }

  const jobs = res.value;
  const onBoard = new Set(jobs.map((j) => j.id));
  const baselining = validating || !company.baselined;
  const statements: Statement[] = [];
  const knownOnBoard: string[] = [];
  const insertedIds = new Set<string>();
  let matched = 0;

  for (const job of jobs) {
    if (ctx.known.has(job.id)) {
      knownOnBoard.push(job.id);
      continue;
    }
    if (insertedIds.has(job.id)) continue;
    insertedIds.add(job.id);
    const row = classifyNew(job, company, baselining, onBoard, ctx);
    if (row.status === "pending" || row.status === "suppressed") matched++;
    statements.push(store.stmtInsertJob(row, ctx.at));
  }
  statements.push(...store.stmtsTouchJobsSeen(company.id, knownOnBoard, ctx.at));
  statements.push(
    store.stmtCompanySuccess(company.id, ctx.at, {
      baselined: baselining || undefined,
      state: validating ? "active" : undefined,
    }),
  );

  return {
    ok: true,
    statements,
    newJobs: insertedIds.size,
    matched,
    ownerMessage: validating
      ? `✅ Added ${escapeHtml(company.name)} (${ATS_NAMES[company.ats]}, ${jobs.length} open jobs). New matching roles will be sent from the next check.`
      : undefined,
  };
}

/** One poller run: check every board, store new jobs, then deliver pending alerts. */
export async function runPoll(deps: PollDeps): Promise<PollStats> {
  const { store, now } = deps;
  const runStartedAt = now();
  await store.setSetting("last_poll_start_at", runStartedAt);

  const settings = await store.getSettings();
  const companies = await store.listCompaniesForPoll();
  const ids = companies.map((c) => c.id);
  const known = await store.knownJobIds(ids);
  const candidates = await store.repostCandidates(ids, runStartedAt);

  const outcomes = await mapPool(companies, FETCH_CONCURRENCY, (company) =>
    pollCompany(company, deps, {
      settings,
      known: known.get(company.id) ?? new Set(),
      candidates: candidates.get(company.id) ?? [],
      at: runStartedAt,
    }),
  );
  await store.runBatch(outcomes.flatMap((o) => o.statements));

  for (const o of outcomes) {
    if (!o.ownerMessage) continue;
    try {
      await deps.telegram.sendMessage(deps.ownerId, o.ownerMessage);
    } catch (err) {
      console.error(`owner notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const stats: PollStats = {
    companiesOk: outcomes.filter((o) => o.ok).length,
    companiesFailed: outcomes.filter((o) => !o.ok).length,
    newJobs: outcomes.reduce((n, o) => n + o.newJobs, 0),
    matched: outcomes.reduce((n, o) => n + o.matched, 0),
    sent: 0,
    sendFailures: 0,
  };

  if (!settings.paused) {
    const delivered = await deliver({ ...deps, excludedWords: settings.excludedWords });
    stats.sent = delivered.sent;
    stats.sendFailures = delivered.sendFailures;
  }

  const finish: Statement[] = [store.stmtSetSetting("last_poll_stats", stats)];
  if (stats.companiesOk > 0) finish.push(store.stmtSetSetting("last_successful_poll_at", now()));
  await store.runBatch(finish);
  return stats;
}
