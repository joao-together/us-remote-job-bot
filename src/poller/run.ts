import { adapterFor } from "../core/ats/detect";
import { ATS_NAMES, type FetchFailure, type FetchResult, type Fetcher, type NormalizedJob } from "../core/ats/types";
import { FETCH_CONCURRENCY, WIDE_SLOT_MS, WIDE_SLOTS } from "../core/config";
import { findExcludedWord, matchesTarget, normalizeTitle, prepareExcludedWords, type MatchResult } from "../core/match/rules";
import type { Statement } from "../core/store/driver";
import type { CompanyRow, JobKey, NewJob, PollStats, RepostCandidate, Settings, Store } from "../core/store/db";
import { escapeHtml } from "../core/telegram/format";
import { errorMessage, REDACTED, redactSecrets } from "../core/util";
import { deliver, type Sender } from "./deliver";

export interface PollDeps {
  store: Store;
  fetcher: Fetcher;
  telegram: Sender;
  ownerId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type { PollStats };

const FAILURE_TEXT: Record<FetchFailure["kind"], string> = {
  not_found: "board not found",
  timeout: "the board timed out",
  http_error: "the board returned an error",
  parse_error: "the board's response couldn't be read",
};

/** Short, secret-free error text for storage and messages. `secrets` are known values to strip too. */
export function redactError(message: string, ...secrets: (string | undefined)[]): string {
  return redactSecrets(message, ...secrets)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, `bot${REDACTED}`)
    .replace(/(token|key|secret|authorization)=[^&\s]+/gi, `$1=${REDACTED}`)
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
  /** settings.excludedWords, tokenized once per run. */
  excludedWords: string[][];
  /** This company's repost candidates, keyed by repostKey. */
  candidates: Map<string, RepostCandidate[]>;
  at: number;
}

/** A job on a fetched board that this run sees for the first time. */
interface FreshJob {
  job: NormalizedJob;
  /** matchesTarget's verdict; undefined while the board is being baselined (nothing matches). */
  match?: MatchResult;
}

const isBaselining = (company: CompanyRow) => company.state === "pending_validation" || !company.baselined;

/**
 * Listing ids not in the company's seen_ids: the only ids that may need a `jobs` lookup (stored
 * matching jobs and legacy 'seen' rows). On an unchanged board these are just its stored matches
 * still open, so a quiet run reads (almost) nothing from `jobs`.
 */
function unseenIds(company: CompanyRow, jobs: readonly NormalizedJob[]): string[] {
  const seen = new Set(company.seenIds);
  return [...new Set(jobs.map((j) => j.id).filter((id) => !seen.has(id)))];
}

/** Jobs not stored, not in seen_ids and not repeated earlier in the listing; matched unless baselining. */
function findFresh(company: CompanyRow, jobs: readonly NormalizedJob[], stored: ReadonlySet<string>): FreshJob[] {
  const baselining = isBaselining(company);
  const oldSeen = new Set(company.seenIds);
  const ids = new Set<string>();
  const out: FreshJob[] = [];
  for (const job of jobs) {
    if (stored.has(job.id) || oldSeen.has(job.id) || ids.has(job.id)) continue;
    ids.add(job.id);
    out.push({ job, match: baselining ? undefined : matchesTarget(job) });
  }
  return out;
}

const repostKey = (normalizedTitle: string, locationText: string) => `${normalizedTitle}\u0000${locationText}`;

function indexCandidates(candidates: readonly RepostCandidate[]): Map<string, RepostCandidate[]> {
  const out = new Map<string, RepostCandidate[]>();
  for (const c of candidates) {
    const key = repostKey(c.normalizedTitle, c.locationText);
    const list = out.get(key);
    if (list) list.push(c);
    else out.set(key, [c]);
  }
  return out;
}

function classifyNew({ job, match }: FreshJob, company: CompanyRow, onBoard: Set<string>, ctx: ClassifyContext): NewJob {
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
  if (!match?.pass) return { ...base, status: "seen" };

  // A repost replaces an earlier sent/pending job that is no longer on the board.
  const sameRole = ctx.candidates.get(repostKey(base.normalizedTitle, base.locationText)) ?? [];
  const isRepost = sameRole.some((c) => !onBoard.has(c.boardJobId));
  let status: NewJob["status"];
  if (isRepost) status = "duplicate";
  else if (findExcludedWord(`${job.title}\n${job.description ?? ""}`, ctx.excludedWords)) status = "excluded";
  else if (ctx.settings.paused) status = "suppressed";
  else status = "pending";
  return {
    ...base,
    locationClass: match.location.cls,
    locationReason: match.location.reason ?? null,
    locationCountries: match.location.countries ?? [],
    locationLatam: match.location.latam ?? false,
    locationEmea: match.location.emea ?? false,
    status,
  };
}

function fetchCompany(company: CompanyRow, fetcher: Fetcher): Promise<FetchResult<NormalizedJob[]>> {
  return adapterFor(company.ats)
    .listJobs(company.boardToken, fetcher)
    .catch((err: unknown): FetchFailure => ({ ok: false, kind: "parse_error", message: errorMessage(err) }));
}

function companyOutcome(
  company: CompanyRow,
  res: FetchResult<NormalizedJob[]>,
  fresh: readonly FreshJob[],
  store: Store,
  ctx: ClassifyContext,
): CompanyOutcome {
  const validating = company.state === "pending_validation";

  if (!res.ok) {
    const error = redactError(res.message);
    return {
      ok: false,
      statements: [store.stmtCompanyFailure(company.id, error, validating ? { state: "inactive" } : {})],
      newJobs: 0,
      matched: 0,
      ownerMessage: validating
        ? `❌ Couldn't add ${escapeHtml(company.name)}: ${FAILURE_TEXT[res.kind]} (${escapeHtml(ATS_NAMES[company.ats])} "${escapeHtml(company.boardToken)}").`
        : undefined,
    };
  }

  const jobs = res.value;
  const onBoard = new Set(jobs.map((j) => j.id));
  const baselining = isBaselining(company);
  const statements: Statement[] = [];
  const oldSeen = new Set(company.seenIds);
  const newlySeen = new Set<string>();
  let matched = 0;
  // New ids that passed matchesTarget (any non-'seen' row: pending, suppressed, excluded, duplicate).
  let passed = 0;

  for (const f of fresh) {
    const row = classifyNew(f, company, onBoard, ctx);
    // Non-matching ids are kept compactly in companies.seen_ids, not as job rows (D1 write budget).
    if (row.status === "seen") {
      newlySeen.add(row.boardJobId);
      continue;
    }
    passed++;
    if (row.status === "pending" || row.status === "suppressed") matched++;
    statements.push(store.stmtInsertJob(row, ctx.at));
  }

  // Next seen set: old ∪ newly seen, restricted to ids still on the board (keeps it bounded).
  const nextSeen = [...onBoard].filter((id) => oldSeen.has(id) || newlySeen.has(id));
  const seenChanged = nextSeen.length !== oldSeen.size || nextSeen.some((id) => !oldSeen.has(id));

  // Write the company row only when something changes, to keep D1 rows-written low. A new
  // matching job records last_match_at and promotes a wide board to fast, in the same statement.
  if (company.consecutiveFailures > 0 || baselining || seenChanged || passed > 0) {
    statements.push(
      store.stmtCompanySuccess(company.id, {
        baselined: baselining || undefined,
        state: validating ? "active" : undefined,
        seenIds: seenChanged ? nextSeen : undefined,
        lastMatchAt: passed > 0 ? ctx.at : undefined,
        tier: passed > 0 && company.tier === "wide" ? "fast" : undefined,
      }),
    );
  }

  return {
    ok: true,
    statements,
    newJobs: fresh.length,
    matched,
    ownerMessage: validating
      ? `✅ Added ${escapeHtml(company.name)} (${ATS_NAMES[company.ats]}, ${jobs.length} open jobs). New matching roles will be sent from the next check.`
      : undefined,
  };
}

/**
 * The wide-tier group a run at `at` checks: one of WIDE_SLOTS groups per WIDE_SLOT_MS window, so
 * runs every 15 minutes cover every wide board about every 90 minutes.
 */
export function wideSlot(at: number): number {
  return Math.floor(at / WIDE_SLOT_MS) % WIDE_SLOTS;
}

/**
 * One poller run: check every fast board, this slot's wide boards, boards being validated and a
 * capped batch of not-yet-baselined boards (Store.listCompaniesForRun); store new jobs, then
 * deliver pending alerts. Boards are fetched first so that `jobs` is read only for ids a board
 * lists outside its seen_ids, and repost candidates only for boards with a new match.
 */
export async function runPoll(deps: PollDeps): Promise<PollStats> {
  const { store, now } = deps;
  const runStartedAt = now();
  await store.setSetting("last_poll_start_at", runStartedAt);

  const companies = await store.listCompaniesForRun(wideSlot(runStartedAt));
  const results = await mapPool(companies, FETCH_CONCURRENCY, (company) => fetchCompany(company, deps.fetcher));

  // D1 reads follow what changed (the free plan allows 5M rows read a day). Stored `jobs` rows
  // of any status (incl. legacy 'seen' rows) count as known, but only listing ids missing from a
  // board's seen_ids are looked up: one index probe each, or, for a board being baselined (whose
  // whole listing is new), its stored rows, usually none. Repost candidates are read only for
  // boards with a new job that passes the match rules.
  const lookups: JobKey[] = [];
  const baselineLookups: number[] = [];
  companies.forEach((company, i) => {
    const res = results[i]!;
    if (!res.ok) return;
    const ids = unseenIds(company, res.value);
    if (ids.length === 0) return;
    if (isBaselining(company)) baselineLookups.push(company.id);
    else for (const id of ids) lookups.push({ companyId: company.id, boardJobId: id });
  });
  const stored = lookups.length > 0 ? await store.storedJobIds(lookups) : new Map<number, Set<string>>();
  if (baselineLookups.length > 0) for (const [id, set] of await store.knownJobIds(baselineLookups)) stored.set(id, set);
  const none = new Set<string>();
  const fresh = companies.map((company, i) => {
    const res = results[i]!;
    return res.ok ? findFresh(company, res.value, stored.get(company.id) ?? none) : [];
  });
  const repostIds = companies.filter((_, i) => fresh[i]!.some((f) => f.match?.pass)).map((c) => c.id);
  const candidates = repostIds.length > 0 ? await store.repostCandidates(repostIds, runStartedAt) : new Map<number, RepostCandidate[]>();

  // Read settings only now, after the (slow) fetch phase, so a /pause or /exclude sent while
  // boards were being fetched still applies to the jobs stored this run.
  const settings = await store.getSettings();
  const excludedWords = prepareExcludedWords(settings.excludedWords);
  const outcomes = companies.map((company, i) =>
    companyOutcome(company, results[i]!, fresh[i]!, store, {
      settings,
      excludedWords,
      candidates: indexCandidates(candidates.get(company.id) ?? []),
      at: runStartedAt,
    }),
  );
  await store.runBatch(outcomes.flatMap((o) => o.statements));

  for (const o of outcomes) {
    if (!o.ownerMessage) continue;
    try {
      await deps.telegram.sendMessage(deps.ownerId, o.ownerMessage);
    } catch (err) {
      console.error(`owner notice failed: ${errorMessage(err)}`);
    }
  }

  const stats: PollStats = {
    companiesOk: outcomes.filter((o) => o.ok).length,
    companiesFailed: outcomes.filter((o) => !o.ok).length,
    newJobs: outcomes.reduce((n, o) => n + o.newJobs, 0),
    matched: outcomes.reduce((n, o) => n + o.matched, 0),
    sent: 0,
    messagesSent: 0,
    sendFailures: 0,
  };

  if (!settings.paused) {
    const delivered = await deliver({ ...deps, excludedWords });
    stats.sent = delivered.sent;
    stats.messagesSent = delivered.messagesSent;
    stats.sendFailures = delivered.sendFailures;
  }

  const finish: Statement[] = [store.stmtSetSetting("last_poll_stats", stats)];
  if (stats.companiesOk > 0) finish.push(store.stmtSetSetting("last_successful_poll_at", now()));
  await store.runBatch(finish);
  return stats;
}
