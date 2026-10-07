import type { AtsKind } from "../ats/types";
import { FAILING_AFTER_CONSECUTIVE, REPOST_WINDOW_MS } from "../config";
import type { LocationClass } from "../match/rules";
import type { DbDriver, Statement } from "./driver";
import { chunk } from "../util";

/** D1 allows at most 100 bound parameters per statement. */
const MAX_IN_PARAMS = 90;
const MAX_ERROR_LENGTH = 500;

export type CompanyState = "active" | "pending_validation" | "inactive";
export type JobStatus = "seen" | "duplicate" | "excluded" | "suppressed" | "pending" | "sending" | "sent";
export type UserAction = "applied" | "skipped";

export interface CompanyRow {
  id: number;
  name: string;
  ats: AtsKind;
  boardToken: string;
  state: CompanyState;
  baselined: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: number;
  failing: boolean;
  /**
   * Board job ids seen on this board that never matched (baseline or failed the filters), kept
   * here instead of as `jobs` rows. Pruned to ids still on the board. Malformed JSON reads as [].
   */
  seenIds: string[];
}

export interface JobRow {
  id: number;
  companyId: number;
  boardJobId: string;
  title: string;
  normalizedTitle: string;
  locationText: string;
  locationClass: LocationClass | null;
  /** Why the location was flagged, recorded at detection; null for plain US jobs. */
  locationReason: string | null;
  applyUrl: string;
  postedAt: number | null;
  salaryText: string | null;
  status: JobStatus;
  telegramMessageId: number | null;
  userAction: UserAction | null;
  actionAt: number | null;
  firstSeenAt: number;
  sentAt: number | null;
}

/** A job joined with its company, as needed for delivery and listings. */
export interface PendingJob extends JobRow {
  companyName: string;
  ats: AtsKind;
  boardToken: string;
}

/** A job a user marked applied; `actionAt` is when that user marked it. */
export type AppliedJob = PendingJob;

/** An invited user (the owner is never stored). */
export interface UserRow {
  userId: string;
  name: string | null;
  active: boolean;
  addedAt: number;
}

export type InviteStatus = "added" | "reactivated" | "exists";

/** One recipient's copy of a sent job and their own Applied/Skip state. */
export interface DeliveryRow {
  jobId: number;
  userId: string;
  telegramMessageId: number | null;
  sentAt: number;
  userAction: UserAction | null;
  actionAt: number | null;
}

/** Summary of one poller run, stored in the `last_poll_stats` setting. */
export interface PollStats {
  companiesOk: number;
  companiesFailed: number;
  /** New board job ids recorded this run, in any status (as a job row or in companies.seen_ids). */
  newJobs: number;
  /** New ids that matched and became pending or suppressed. */
  matched: number;
  /** Jobs delivered to at least one recipient. */
  sent: number;
  /** Alert messages sent, across all recipients. */
  messagesSent?: number;
  sendFailures: number;
}

export interface Settings {
  paused: boolean;
  excludedWords: string[];
  lastPollStartAt?: number;
  lastSuccessfulPollAt?: number;
  lastPollStats?: PollStats;
  lastWarningAt?: number;
}

export type SettingKey =
  | "paused"
  | "excluded_words"
  | "last_poll_start_at"
  | "last_successful_poll_at"
  | "last_poll_stats"
  | "last_warning_at";

export interface NewCompany {
  name: string;
  ats: AtsKind;
  boardToken: string;
  state?: CompanyState;
}

export type InsertCompanyStatus = "added" | "exists" | "reactivated";

export interface NewJob {
  companyId: number;
  boardJobId: string;
  title: string;
  normalizedTitle: string;
  locationText: string;
  locationClass?: LocationClass | null;
  locationReason?: string | null;
  applyUrl: string;
  postedAt?: number | null;
  salaryText?: string | null;
  status: Exclude<JobStatus, "sending" | "sent">;
}

/** An earlier sent/pending/sending job that a new id with the same title and location may be a repost of. */
export interface RepostCandidate {
  companyId: number;
  boardJobId: string;
  normalizedTitle: string;
  locationText: string;
}

export interface StatusCounts {
  sentToday: number;
  active: number;
  failing: number;
  pendingValidation: number;
  pending: number;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Parses companies.seen_ids; anything malformed is treated as an empty list. Deduped. */
export function parseSeenIds(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string | number => typeof x === "string" || typeof x === "number").map(String))];
  } catch {
    return [];
  }
}

function toCompany(r: Raw): CompanyRow {
  const consecutiveFailures = num(r.consecutive_failures);
  return {
    id: num(r.id),
    name: String(r.name),
    ats: r.ats as AtsKind,
    boardToken: String(r.board_token),
    state: r.state as CompanyState,
    baselined: num(r.baselined) === 1,
    consecutiveFailures,
    lastError: strOrNull(r.last_error),
    createdAt: num(r.created_at),
    failing: consecutiveFailures >= FAILING_AFTER_CONSECUTIVE,
    seenIds: parseSeenIds(r.seen_ids),
  };
}

function toJob(r: Raw): JobRow {
  return {
    id: num(r.id),
    companyId: num(r.company_id),
    boardJobId: String(r.board_job_id),
    title: String(r.title),
    normalizedTitle: String(r.normalized_title),
    locationText: String(r.location_text ?? ""),
    locationClass: strOrNull(r.location_class) as LocationClass | null,
    locationReason: strOrNull(r.location_reason),
    applyUrl: String(r.apply_url),
    postedAt: numOrNull(r.posted_at),
    salaryText: strOrNull(r.salary_text),
    status: r.status as JobStatus,
    telegramMessageId: numOrNull(r.telegram_message_id),
    userAction: (r.user_action as UserAction | null) ?? null,
    actionAt: numOrNull(r.action_at),
    firstSeenAt: num(r.first_seen_at),
    sentAt: numOrNull(r.sent_at),
  };
}

function toUser(r: Raw): UserRow {
  return { userId: String(r.user_id), name: strOrNull(r.name), active: num(r.active) === 1, addedAt: num(r.added_at) };
}

function toDelivery(r: Raw): DeliveryRow {
  return {
    jobId: num(r.job_id),
    userId: String(r.user_id),
    telegramMessageId: numOrNull(r.telegram_message_id),
    sentAt: num(r.sent_at),
    userAction: (r.user_action as UserAction | null) ?? null,
    actionAt: numOrNull(r.action_at),
  };
}

function toPendingJob(r: Raw): PendingJob {
  return { ...toJob(r), companyName: String(r.company_name), ats: r.ats as AtsKind, boardToken: String(r.board_token) };
}

const JOB_WITH_COMPANY = `SELECT j.*, c.name AS company_name, c.ats AS ats, c.board_token AS board_token
  FROM jobs j JOIN companies c ON c.id = j.company_id`;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export class Store {
  constructor(
    private readonly driver: DbDriver,
    private readonly now: () => number = Date.now,
  ) {}

  runBatch(stmts: Statement[]): Promise<void> {
    return stmts.length === 0 ? Promise.resolve() : this.driver.batch(stmts);
  }

  // ---- settings ----

  async getSettings(): Promise<Settings> {
    const rows = await this.driver.query<{ key: string; value: string }>({ sql: "SELECT key, value FROM settings" });
    const map = new Map<string, unknown>();
    for (const row of rows) {
      try {
        map.set(row.key, JSON.parse(row.value));
      } catch {
        // Ignore a malformed value; it falls back to the default.
      }
    }
    const optNum = (k: SettingKey) => (typeof map.get(k) === "number" ? (map.get(k) as number) : undefined);
    const words = map.get("excluded_words");
    const stats = map.get("last_poll_stats");
    return {
      paused: map.get("paused") === true,
      excludedWords: Array.isArray(words) ? words.filter((w): w is string => typeof w === "string") : [],
      lastPollStartAt: optNum("last_poll_start_at"),
      lastSuccessfulPollAt: optNum("last_successful_poll_at"),
      lastPollStats: stats && typeof stats === "object" ? (stats as PollStats) : undefined,
      lastWarningAt: optNum("last_warning_at"),
    };
  }

  /** Just the paused flag: one small read, cheap enough to check before every send. */
  async isPaused(): Promise<boolean> {
    const rows = await this.driver.query<{ value: string }>({ sql: "SELECT value FROM settings WHERE key = 'paused'" });
    try {
      return rows[0] ? JSON.parse(rows[0].value) === true : false;
    } catch {
      return false;
    }
  }

  stmtSetSetting(key: SettingKey, value: unknown): Statement {
    return {
      sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params: [key, JSON.stringify(value)],
    };
  }

  async setSetting(key: SettingKey, value: unknown): Promise<void> {
    await this.driver.query(this.stmtSetSetting(key, value));
  }

  /** `word` must already be canonical (see normalizeExcludedWord in match/rules). */
  async addExcludedWord(word: string): Promise<string[]> {
    const { excludedWords } = await this.getSettings();
    if (!word || excludedWords.includes(word)) return excludedWords;
    const next = [...excludedWords, word];
    await this.setSetting("excluded_words", next);
    return next;
  }

  /** `word` must already be canonical (see normalizeExcludedWord in match/rules). */
  async removeExcludedWord(word: string): Promise<string[]> {
    const { excludedWords } = await this.getSettings();
    const next = excludedWords.filter((x) => x !== word);
    if (next.length !== excludedWords.length) await this.setSetting("excluded_words", next);
    return next;
  }

  // ---- pause ----

  /** Sets paused and moves every pending job to suppressed, atomically. */
  async pause(): Promise<void> {
    await this.driver.batch([
      this.stmtSetSetting("paused", true),
      { sql: "UPDATE jobs SET status = 'suppressed' WHERE status = 'pending'" },
    ]);
  }

  async resume(): Promise<void> {
    await this.setSetting("paused", false);
  }

  // ---- companies ----

  async listCompaniesForPoll(): Promise<CompanyRow[]> {
    const rows = await this.driver.query<Raw>({
      sql: "SELECT * FROM companies WHERE state IN ('active', 'pending_validation') ORDER BY id",
    });
    return rows.map(toCompany);
  }

  async listCompanies(opts: { includeInactive?: boolean } = {}): Promise<CompanyRow[]> {
    const where = opts.includeInactive ? "" : "WHERE state != 'inactive'";
    const rows = await this.driver.query<Raw>({ sql: `SELECT * FROM companies ${where} ORDER BY name COLLATE NOCASE, id` });
    return rows.map(toCompany);
  }

  async getCompany(id: number): Promise<CompanyRow | null> {
    const rows = await this.driver.query<Raw>({ sql: "SELECT * FROM companies WHERE id = ?", params: [id] });
    return rows[0] ? toCompany(rows[0]) : null;
  }

  /** Inserts a company, or reactivates an inactive one with the same board as pending_validation. */
  async insertCompany(c: NewCompany): Promise<{ status: InsertCompanyStatus; company: CompanyRow }> {
    const existing = await this.driver.query<Raw>({
      sql: "SELECT * FROM companies WHERE ats = ? AND board_token = ?",
      params: [c.ats, c.boardToken],
    });
    const found = existing[0];
    if (found) {
      const company = toCompany(found);
      if (company.state !== "inactive") return { status: "exists", company };
      const rows = await this.driver.query<Raw>({
        sql: "UPDATE companies SET state = 'pending_validation', consecutive_failures = 0, last_error = NULL WHERE id = ? RETURNING *",
        params: [company.id],
      });
      return { status: "reactivated", company: toCompany(rows[0] ?? found) };
    }
    const rows = await this.driver.query<Raw>({
      sql: `INSERT INTO companies (name, ats, board_token, state, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ats, board_token) DO NOTHING RETURNING *`,
      params: [c.name, c.ats, c.boardToken, c.state ?? "pending_validation", this.now()],
    });
    if (rows[0]) return { status: "added", company: toCompany(rows[0]) };
    // Lost a race with a concurrent insert of the same board.
    const again = await this.driver.query<Raw>({
      sql: "SELECT * FROM companies WHERE ats = ? AND board_token = ?",
      params: [c.ats, c.boardToken],
    });
    return { status: "exists", company: toCompany(again[0] as Raw) };
  }

  /**
   * Inserts an already-vetted company as active and unbaselined, so the poller baselines it
   * silently (capped per run by BASELINE_COMPANIES_PER_RUN). A board already present, in any
   * state, is left untouched.
   */
  stmtInsertActiveCompany(c: Pick<NewCompany, "name" | "ats" | "boardToken">, at: number = this.now()): Statement {
    return {
      sql: `INSERT INTO companies (name, ats, board_token, state, baselined, consecutive_failures, created_at)
        VALUES (?, ?, ?, 'active', 0, 0, ?) ON CONFLICT(ats, board_token) DO NOTHING`,
      params: [c.name, c.ats, c.boardToken, Math.trunc(at)],
    };
  }

  /** Case-insensitive match on company name or board token. */
  async findCompaniesByName(name: string): Promise<CompanyRow[]> {
    const rows = await this.driver.query<Raw>({
      sql: "SELECT * FROM companies WHERE lower(name) = lower(?) OR lower(board_token) = lower(?) ORDER BY id",
      params: [name.trim(), name.trim()],
    });
    return rows.map(toCompany);
  }

  stmtSetCompanyState(id: number, state: CompanyState): Statement {
    return { sql: "UPDATE companies SET state = ? WHERE id = ?", params: [state, id] };
  }

  async setCompanyState(id: number, state: CompanyState): Promise<void> {
    await this.driver.query(this.stmtSetCompanyState(id, state));
  }

  async failingCompanies(): Promise<CompanyRow[]> {
    const rows = await this.driver.query<Raw>({
      sql: "SELECT * FROM companies WHERE state = 'active' AND consecutive_failures >= ? ORDER BY name COLLATE NOCASE",
      params: [FAILING_AFTER_CONSECUTIVE],
    });
    return rows.map(toCompany);
  }

  // ---- poll ----

  /** "companyId:boardJobId" keys of jobs that already went through matching (anything but legacy 'seen'). */
  async matchedJobKeys(): Promise<Set<string>> {
    const rows = await this.driver.query<{ company_id: number; board_job_id: string }>({
      sql: "SELECT company_id, board_job_id FROM jobs WHERE status <> 'seen'",
    });
    return new Set(rows.map((r) => `${r.company_id}:${r.board_job_id}`));
  }

  /**
   * Every board job id stored as a `jobs` row (any status, including legacy 'seen' rows), per
   * company, loaded in chunks of company ids. Ids in companies.seen_ids are known too; the
   * poller merges those from the company rows.
   */
  async knownJobIds(companyIds: number[]): Promise<Map<number, Set<string>>> {
    const out = new Map<number, Set<string>>();
    for (const id of companyIds) out.set(id, new Set());
    for (const ids of chunk(companyIds, MAX_IN_PARAMS)) {
      const rows = await this.driver.query<{ company_id: number; board_job_id: string }>({
        sql: `SELECT company_id, board_job_id FROM jobs WHERE company_id IN (${placeholders(ids.length)})`,
        params: ids,
      });
      for (const r of rows) out.get(num(r.company_id))?.add(String(r.board_job_id));
    }
    return out;
  }

  /** Inserts a job; an existing (company, board job id) is left untouched. */
  /**
   * Turns a legacy 'seen' row (stored before seen ids moved to companies.seen_ids) into a job with
   * the given details and status. Used by the open-roles backfill, whose plain insert would no-op.
   */
  stmtRequeueSeenJob(job: NewJob, at: number = this.now()): Statement {
    return {
      sql: `UPDATE jobs SET title = ?, normalized_title = ?, location_text = ?, location_class = ?, location_reason = ?,
          apply_url = ?, posted_at = ?, salary_text = ?, status = ?, first_seen_at = ?
        WHERE company_id = ? AND board_job_id = ? AND status = 'seen'`,
      params: [
        job.title,
        job.normalizedTitle,
        job.locationText,
        job.locationClass ?? null,
        job.locationReason ?? null,
        job.applyUrl,
        job.postedAt ?? null,
        job.salaryText ?? null,
        job.status,
        at,
        job.companyId,
        job.boardJobId,
      ],
    };
  }

  stmtInsertJob(job: NewJob, at: number = this.now()): Statement {
    return {
      sql: `INSERT INTO jobs (company_id, board_job_id, title, normalized_title, location_text, location_class,
          location_reason, apply_url, posted_at, salary_text, status, first_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, board_job_id) DO NOTHING`,
      params: [
        job.companyId,
        job.boardJobId,
        job.title,
        job.normalizedTitle,
        job.locationText,
        job.locationClass ?? null,
        job.locationReason ?? null,
        job.applyUrl,
        job.postedAt ?? null,
        job.salaryText ?? null,
        job.status,
        at,
      ],
    };
  }

  /**
   * Clears the failure count and error, optionally setting baselined/state/name/seen ids.
   * `state` is a validation outcome: it only applies while the row is still pending_validation,
   * so a concurrent /remove (state inactive) is never undone.
   */
  stmtCompanySuccess(
    companyId: number,
    opts: { baselined?: boolean; state?: CompanyState; name?: string; seenIds?: readonly string[] } = {},
  ): Statement {
    const sets = ["consecutive_failures = 0", "last_error = NULL"];
    const params: unknown[] = [];
    if (opts.baselined) sets.push("baselined = 1");
    if (opts.seenIds) {
      sets.push("seen_ids = ?");
      params.push(JSON.stringify(opts.seenIds));
    }
    if (opts.state) {
      sets.push("state = CASE WHEN state = 'pending_validation' THEN ? ELSE state END");
      params.push(opts.state);
    }
    if (opts.name) {
      sets.push("name = ?");
      params.push(opts.name);
    }
    return { sql: `UPDATE companies SET ${sets.join(", ")} WHERE id = ?`, params: [...params, companyId] };
  }

  /**
   * `redactedError` must already be stripped of secrets. Like stmtCompanySuccess, `state` only
   * applies while the row is still pending_validation.
   */
  stmtCompanyFailure(companyId: number, redactedError: string, opts: { state?: CompanyState } = {}): Statement {
    const stateSql = opts.state ? ", state = CASE WHEN state = 'pending_validation' THEN ? ELSE state END" : "";
    return {
      sql: `UPDATE companies SET consecutive_failures = consecutive_failures + 1, last_error = ?${stateSql} WHERE id = ?`,
      params: [redactedError.slice(0, MAX_ERROR_LENGTH), ...(opts.state ? [opts.state] : []), companyId],
    };
  }

  // ---- repost guard ----

  /**
   * Repost lookup: every pending/sending/sent job of these companies first seen within the window.
   * A new id is a repost when a candidate with the same normalized title and location text is no
   * longer on the board in the current fetch; the poller does that check in memory.
   */
  async repostCandidates(companyIds: number[], runStartedAt: number): Promise<Map<number, RepostCandidate[]>> {
    const out = new Map<number, RepostCandidate[]>();
    for (const ids of chunk(companyIds, MAX_IN_PARAMS)) {
      const rows = await this.driver.query<Raw>({
        sql: `SELECT company_id, board_job_id, normalized_title, location_text FROM jobs
          WHERE company_id IN (${placeholders(ids.length)}) AND status IN ('sent', 'pending', 'sending')
          AND first_seen_at >= ?`,
        params: [...ids, runStartedAt - REPOST_WINDOW_MS],
      });
      for (const r of rows) {
        const companyId = num(r.company_id);
        const list = out.get(companyId) ?? [];
        list.push({
          companyId,
          boardJobId: String(r.board_job_id),
          normalizedTitle: String(r.normalized_title),
          locationText: String(r.location_text ?? ""),
        });
        out.set(companyId, list);
      }
    }
    return out;
  }

  // ---- delivery ----

  /** Pending jobs, oldest first. Rows left in `sending` are treated as sent and never returned. */
  async listPending(limit?: number): Promise<PendingJob[]> {
    const rows = await this.driver.query<Raw>({
      sql: `${JOB_WITH_COMPANY} WHERE j.status = 'pending' ORDER BY j.first_seen_at, j.id${limit ? " LIMIT ?" : ""}`,
      params: limit ? [limit] : [],
    });
    return rows.map(toPendingJob);
  }

  /**
   * Moves pending -> sending. Returns false when the job was neither pending nor sending.
   *
   * Idempotent on purpose: the D1 HTTP driver may retry a request whose first attempt was applied
   * but whose response was lost; the retry then sees 'sending' and must still report success, or
   * the job would be skipped and stranded in 'sending' without ever being sent. Accepting
   * 'sending' is safe because only one poller runs at a time (Actions concurrency group) and
   * deliver() only passes ids from listPending(), which returns 'pending' rows only, so a stale
   * 'sending' row from an earlier run is never claimed again.
   */
  async markSending(jobId: number): Promise<boolean> {
    const rows = await this.driver.query({
      sql: "UPDATE jobs SET status = 'sending' WHERE id = ? AND status IN ('pending', 'sending') RETURNING id",
      params: [jobId],
    });
    return rows.length > 0;
  }

  /** Moves sending -> pending, for sends Telegram definitely rejected. */
  async revertSending(jobId: number): Promise<void> {
    await this.driver.query({
      sql: "UPDATE jobs SET status = 'pending' WHERE id = ? AND status = 'sending'",
      params: [jobId],
    });
  }

  /** `messageId` is the owner's copy (null when only other recipients received it). */
  async markSent(jobId: number, messageId: number | null, at: number = this.now()): Promise<void> {
    await this.driver.query({
      sql: "UPDATE jobs SET status = 'sent', telegram_message_id = ?, sent_at = ? WHERE id = ? AND status IN ('sending', 'pending')",
      params: [messageId, at, jobId],
    });
  }

  async markExcluded(jobId: number): Promise<void> {
    await this.driver.query({ sql: "UPDATE jobs SET status = 'excluded' WHERE id = ? AND status = 'pending'", params: [jobId] });
  }

  /** Marks a pending job whose posting has vanished from the board as seen (terminal, never sent). */
  async markGone(jobId: number): Promise<void> {
    await this.driver.query({ sql: "UPDATE jobs SET status = 'seen' WHERE id = ? AND status = 'pending'", params: [jobId] });
  }

  async updateJobDetail(jobId: number, detail: { salaryText?: string | null }): Promise<void> {
    if (detail.salaryText === undefined) return;
    await this.driver.query({ sql: "UPDATE jobs SET salary_text = ? WHERE id = ?", params: [detail.salaryText, jobId] });
  }

  // ---- user actions and queries ----

  async getJob(jobId: number): Promise<PendingJob | null> {
    const rows = await this.driver.query<Raw>({ sql: `${JOB_WITH_COMPANY} WHERE j.id = ?`, params: [jobId] });
    return rows[0] ? toPendingJob(rows[0]) : null;
  }

  /** Records that `userId` was sent job `jobId` as message `messageId`. */
  async recordDelivery(jobId: number, userId: string, messageId: number, at: number = this.now()): Promise<void> {
    await this.driver.query({
      sql: `INSERT INTO deliveries (job_id, user_id, telegram_message_id, sent_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(job_id, user_id) DO UPDATE SET telegram_message_id = excluded.telegram_message_id, sent_at = excluded.sent_at`,
      params: [jobId, userId, messageId, at],
    });
  }

  async getDelivery(jobId: number, userId: string): Promise<DeliveryRow | null> {
    const rows = await this.driver.query<Raw>({
      sql: "SELECT * FROM deliveries WHERE job_id = ? AND user_id = ?",
      params: [jobId, userId],
    });
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  /**
   * Records one user's applied/skipped on a sent job; repeating the same action keeps its time.
   * Upserts, so a tap on an alert sent before per-user deliveries existed (no deliveries row)
   * still works; `messageId` is the tapped message's id. Null if the job isn't sent.
   */
  async setDeliveryAction(
    jobId: number,
    userId: string,
    action: UserAction,
    at: number = this.now(),
    messageId: number | null = null,
  ): Promise<DeliveryRow | null> {
    const rows = await this.driver.query<Raw>({
      sql: `INSERT INTO deliveries (job_id, user_id, telegram_message_id, sent_at, user_action, action_at)
        SELECT j.id, ?, ?, COALESCE(j.sent_at, ?), ?, ? FROM jobs j WHERE j.id = ? AND j.status = 'sent'
        ON CONFLICT(job_id, user_id) DO UPDATE SET
          action_at = CASE WHEN deliveries.user_action = excluded.user_action AND deliveries.action_at IS NOT NULL
            THEN deliveries.action_at ELSE excluded.action_at END,
          user_action = excluded.user_action,
          telegram_message_id = COALESCE(deliveries.telegram_message_id, excluded.telegram_message_id)
        RETURNING *`,
      params: [userId, messageId, at, action, at, jobId],
    });
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  /**
   * Jobs `userId` marked applied, newest action first. With `includeLegacy` (the owner), jobs
   * marked applied before per-user deliveries existed (jobs.user_action) are included too,
   * unless the user has a deliveries row for that job (which then wins).
   */
  async listApplied(userId: string, limit = 20, opts: { includeLegacy?: boolean } = {}): Promise<AppliedJob[]> {
    const cols = "j.*, c.name AS company_name, c.ats AS ats, c.board_token AS board_token";
    const rows = await this.driver.query<Raw>({
      sql: `SELECT ${cols}, d.action_at AS applied_at
          FROM deliveries d JOIN jobs j ON j.id = d.job_id JOIN companies c ON c.id = j.company_id
          WHERE d.user_id = ? AND d.user_action = 'applied'
        UNION ALL
        SELECT ${cols}, j.action_at AS applied_at
          FROM jobs j JOIN companies c ON c.id = j.company_id
          WHERE ? = 1 AND j.user_action = 'applied'
            AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.job_id = j.id AND d.user_id = ?)
        ORDER BY applied_at DESC, id DESC LIMIT ?`,
      params: [userId, opts.includeLegacy ? 1 : 0, userId, limit],
    });
    return rows.map((r) => ({ ...toPendingJob(r), actionAt: numOrNull(r.applied_at) }));
  }

  // ---- users (whitelist) ----

  /** Everyone who gets alerts: the owner first, then active invited users in invite order. */
  async listRecipients(ownerId: string): Promise<string[]> {
    const rows = await this.driver.query<{ user_id: string }>({
      sql: "SELECT user_id FROM users WHERE active = 1 AND user_id <> ? ORDER BY added_at, user_id",
      params: [ownerId],
    });
    return [ownerId, ...rows.map((r) => String(r.user_id))];
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const rows = await this.driver.query<Raw>({ sql: "SELECT * FROM users WHERE user_id = ?", params: [userId] });
    return rows[0] ? toUser(rows[0]) : null;
  }

  async isActiveUser(userId: string): Promise<boolean> {
    const rows = await this.driver.query({ sql: "SELECT 1 AS x FROM users WHERE user_id = ? AND active = 1", params: [userId] });
    return rows.length > 0;
  }

  /** Active invited users, oldest first. */
  async listUsers(): Promise<UserRow[]> {
    const rows = await this.driver.query<Raw>({ sql: "SELECT * FROM users WHERE active = 1 ORDER BY added_at, user_id" });
    return rows.map(toUser);
  }

  async countActiveUsers(): Promise<number> {
    const rows = await this.driver.query<Raw>({ sql: "SELECT COUNT(*) AS n FROM users WHERE active = 1" });
    return num(rows[0]?.n ?? 0);
  }

  /**
   * Adds or reactivates an invited user. The name comes from their access request when there is
   * one (otherwise an earlier stored name is kept).
   */
  async inviteUser(userId: string, at: number = this.now()): Promise<{ status: InviteStatus; user: UserRow }> {
    const existing = await this.getUser(userId);
    if (existing?.active) return { status: "exists", user: existing };
    const rows = await this.driver.query<Raw>({
      sql: `INSERT INTO users (user_id, name, active, added_at)
        VALUES (?, (SELECT name FROM access_requests WHERE user_id = ?), 1, ?)
        ON CONFLICT(user_id) DO UPDATE SET active = 1, added_at = excluded.added_at,
          name = COALESCE(excluded.name, users.name)
        RETURNING *`,
      params: [userId, userId, at],
    });
    return { status: existing ? "reactivated" : "added", user: toUser(rows[0]!) };
  }

  /** Deactivates an invited user. Returns the user if they were active, else null. */
  async revokeUser(userId: string): Promise<UserRow | null> {
    const rows = await this.driver.query<Raw>({
      sql: "UPDATE users SET active = 0 WHERE user_id = ? AND active = 1 RETURNING *",
      params: [userId],
    });
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** Records a first contact from an unknown user. True only the first time for that user. */
  async recordAccessRequest(userId: string, name: string | null, at: number = this.now()): Promise<boolean> {
    const rows = await this.driver.query({
      sql: `INSERT INTO access_requests (user_id, name, requested_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO NOTHING RETURNING user_id`,
      params: [userId, name, at],
    });
    return rows.length > 0;
  }

  async statusCounts(sinceMidnightUtc: number): Promise<StatusCounts> {
    const rows = await this.driver.query<Raw>({
      sql: `SELECT
          (SELECT COUNT(*) FROM jobs WHERE status = 'sent' AND sent_at >= ?) AS sent_today,
          (SELECT COUNT(*) FROM companies WHERE state = 'active') AS active,
          (SELECT COUNT(*) FROM companies WHERE state = 'active' AND consecutive_failures >= ?) AS failing,
          (SELECT COUNT(*) FROM companies WHERE state = 'pending_validation') AS pending_validation,
          (SELECT COUNT(*) FROM jobs WHERE status = 'pending') AS pending`,
      params: [sinceMidnightUtc, FAILING_AFTER_CONSECUTIVE],
    });
    const r = rows[0] ?? {};
    return {
      sentToday: num(r.sent_today ?? 0),
      active: num(r.active ?? 0),
      failing: num(r.failing ?? 0),
      pendingValidation: num(r.pending_validation ?? 0),
      pending: num(r.pending ?? 0),
    };
  }
}

/** Epoch ms of the most recent UTC midnight at or before `at`. */
export function utcMidnight(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
