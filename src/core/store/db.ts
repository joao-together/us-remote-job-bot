import type { AtsKind } from "../ats/types";
import { FAILING_AFTER_CONSECUTIVE, REPOST_WINDOW_MS } from "../config";
import type { DbDriver, Statement } from "./driver";
import { chunk } from "./driver-binding";

/** D1 allows at most 100 bound parameters per statement. */
const MAX_IN_PARAMS = 90;
const MAX_ERROR_LENGTH = 500;

export type CompanyState = "active" | "pending_validation" | "inactive";
export type JobStatus = "seen" | "duplicate" | "excluded" | "suppressed" | "pending" | "sending" | "sent";
export type UserAction = "applied" | "skipped";
export type LocationClass = "us" | "us_restricted" | "ambiguous" | "non_us" | "onsite";

export interface CompanyRow {
  id: number;
  name: string;
  ats: AtsKind;
  boardToken: string;
  state: CompanyState;
  baselined: boolean;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: number;
  failing: boolean;
}

export interface JobRow {
  id: number;
  companyId: number;
  boardJobId: string;
  title: string;
  normalizedTitle: string;
  locationText: string;
  locationClass: string | null;
  applyUrl: string;
  postedAt: number | null;
  salaryText: string | null;
  status: JobStatus;
  telegramMessageId: number | null;
  userAction: UserAction | null;
  actionAt: number | null;
  firstSeenAt: number;
  lastSeenOnBoardAt: number;
  sentAt: number | null;
}

/** A job joined with its company, as needed for delivery and listings. */
export interface PendingJob extends JobRow {
  companyName: string;
  ats: AtsKind;
  boardToken: string;
}

export type AppliedJob = PendingJob;

export interface PollStats {
  companiesOk: number;
  companiesFailed: number;
  sent: number;
  [key: string]: unknown;
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
  locationClass?: string | null;
  applyUrl: string;
  postedAt?: number | null;
  salaryText?: string | null;
  status: Exclude<JobStatus, "sending" | "sent">;
}

/** An earlier sent/pending job that a new id with the same title and location may be a repost of. */
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

function toCompany(r: Raw): CompanyRow {
  const consecutiveFailures = num(r.consecutive_failures);
  return {
    id: num(r.id),
    name: String(r.name),
    ats: r.ats as AtsKind,
    boardToken: String(r.board_token),
    state: r.state as CompanyState,
    baselined: num(r.baselined) === 1,
    lastCheckedAt: numOrNull(r.last_checked_at),
    lastSuccessAt: numOrNull(r.last_success_at),
    consecutiveFailures,
    lastError: strOrNull(r.last_error),
    createdAt: num(r.created_at),
    failing: consecutiveFailures >= FAILING_AFTER_CONSECUTIVE,
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
    locationClass: strOrNull(r.location_class),
    applyUrl: String(r.apply_url),
    postedAt: numOrNull(r.posted_at),
    salaryText: strOrNull(r.salary_text),
    status: r.status as JobStatus,
    telegramMessageId: numOrNull(r.telegram_message_id),
    userAction: (r.user_action as UserAction | null) ?? null,
    actionAt: numOrNull(r.action_at),
    firstSeenAt: num(r.first_seen_at),
    lastSeenOnBoardAt: num(r.last_seen_on_board_at),
    sentAt: numOrNull(r.sent_at),
  };
}

function toPendingJob(r: Raw): PendingJob {
  return { ...toJob(r), companyName: String(r.company_name), ats: r.ats as AtsKind, boardToken: String(r.board_token) };
}

const JOB_WITH_COMPANY = `SELECT j.*, c.name AS company_name, c.ats AS ats, c.board_token AS board_token
  FROM jobs j JOIN companies c ON c.id = j.company_id`;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export function normalizeExcludedWord(word: string): string {
  return word.trim().toLowerCase();
}

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

  stmtSetSetting(key: SettingKey, value: unknown): Statement {
    return {
      sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params: [key, JSON.stringify(value)],
    };
  }

  async setSetting(key: SettingKey, value: unknown): Promise<void> {
    await this.driver.query(this.stmtSetSetting(key, value));
  }

  async addExcludedWord(word: string): Promise<string[]> {
    const w = normalizeExcludedWord(word);
    const { excludedWords } = await this.getSettings();
    if (!w || excludedWords.includes(w)) return excludedWords;
    const next = [...excludedWords, w];
    await this.setSetting("excluded_words", next);
    return next;
  }

  async removeExcludedWord(word: string): Promise<string[]> {
    const w = normalizeExcludedWord(word);
    const { excludedWords } = await this.getSettings();
    const next = excludedWords.filter((x) => x !== w);
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

  /** Every stored board job id, per company, loaded in chunks of company ids. */
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
  stmtInsertJob(job: NewJob, at: number = this.now()): Statement {
    return {
      sql: `INSERT INTO jobs (company_id, board_job_id, title, normalized_title, location_text, location_class,
          apply_url, posted_at, salary_text, status, first_seen_at, last_seen_on_board_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, board_job_id) DO NOTHING`,
      params: [
        job.companyId,
        job.boardJobId,
        job.title,
        job.normalizedTitle,
        job.locationText,
        job.locationClass ?? null,
        job.applyUrl,
        job.postedAt ?? null,
        job.salaryText ?? null,
        job.status,
        at,
        at,
      ],
    };
  }

  /**
   * Updates last_seen_on_board_at for known jobs still on the board. Only rows that can be repost
   * candidates (pending/sending/sent) are touched, to keep D1 rows-written low.
   */
  stmtsTouchJobsSeen(companyId: number, boardJobIds: string[], at: number): Statement[] {
    return chunk(boardJobIds, MAX_IN_PARAMS).map((ids) => ({
      sql: `UPDATE jobs SET last_seen_on_board_at = ?
        WHERE company_id = ? AND status IN ('pending', 'sending', 'sent') AND board_job_id IN (${placeholders(ids.length)})`,
      params: [at, companyId, ...ids],
    }));
  }

  stmtCompanySuccess(
    companyId: number,
    at: number,
    opts: { baselined?: boolean; state?: CompanyState; name?: string } = {},
  ): Statement {
    const sets = ["last_checked_at = ?", "last_success_at = ?", "consecutive_failures = 0", "last_error = NULL"];
    const params: unknown[] = [at, at];
    if (opts.baselined) sets.push("baselined = 1");
    if (opts.state) {
      sets.push("state = ?");
      params.push(opts.state);
    }
    if (opts.name) {
      sets.push("name = ?");
      params.push(opts.name);
    }
    return { sql: `UPDATE companies SET ${sets.join(", ")} WHERE id = ?`, params: [...params, companyId] };
  }

  /** `redactedError` must already be stripped of secrets. */
  stmtCompanyFailure(companyId: number, at: number, redactedError: string, opts: { state?: CompanyState } = {}): Statement {
    const stateSql = opts.state ? ", state = ?" : "";
    return {
      sql: `UPDATE companies SET last_checked_at = ?, consecutive_failures = consecutive_failures + 1, last_error = ?${stateSql}
        WHERE id = ?`,
      params: [at, redactedError.slice(0, MAX_ERROR_LENGTH), ...(opts.state ? [opts.state] : []), companyId],
    };
  }

  // ---- repost guard ----

  /**
   * True when an earlier pending/sending/sent job of the company with the same normalized title and
   * location, first seen within the repost window, was not seen on the board in this run.
   */
  async isRepost(companyId: number, normalizedTitle: string, locationText: string, runStartedAt: number): Promise<boolean> {
    const rows = await this.driver.query({
      sql: `SELECT 1 AS hit FROM jobs WHERE company_id = ? AND normalized_title = ? AND location_text = ?
        AND status IN ('sent', 'pending', 'sending') AND first_seen_at >= ? AND last_seen_on_board_at < ? LIMIT 1`,
      params: [companyId, normalizedTitle, locationText, runStartedAt - REPOST_WINDOW_MS, runStartedAt],
    });
    return rows.length > 0;
  }

  /**
   * Batched repost lookup: every pending/sending/sent job of these companies first seen within the
   * window. The poller must drop candidates whose boardJobId is on the board in the current fetch
   * (their last_seen is not yet updated when classification runs), then match on title + location.
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

  /** Moves pending -> sending. Returns false when the job was not pending. */
  async markSending(jobId: number): Promise<boolean> {
    const rows = await this.driver.query({
      sql: "UPDATE jobs SET status = 'sending' WHERE id = ? AND status = 'pending' RETURNING id",
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

  async markSent(jobId: number, messageId: number, at: number = this.now()): Promise<void> {
    await this.driver.query({
      sql: "UPDATE jobs SET status = 'sent', telegram_message_id = ?, sent_at = ? WHERE id = ? AND status IN ('sending', 'pending')",
      params: [messageId, at, jobId],
    });
  }

  async markExcluded(jobId: number): Promise<void> {
    await this.driver.query({ sql: "UPDATE jobs SET status = 'excluded' WHERE id = ? AND status = 'pending'", params: [jobId] });
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

  /** Records applied/skipped on a sent job. Repeating the same action keeps its time. Null if not a sent job. */
  async setUserAction(jobId: number, action: UserAction, at: number = this.now()): Promise<JobRow | null> {
    const rows = await this.driver.query<Raw>({
      sql: `UPDATE jobs SET action_at = CASE WHEN user_action = ? AND action_at IS NOT NULL THEN action_at ELSE ? END,
          user_action = ?
        WHERE id = ? AND status = 'sent' RETURNING *`,
      params: [action, at, action, jobId],
    });
    return rows[0] ? toJob(rows[0]) : null;
  }

  /** Applied jobs, newest action first. */
  async listApplied(limit = 20): Promise<AppliedJob[]> {
    const rows = await this.driver.query<Raw>({
      sql: `${JOB_WITH_COMPANY} WHERE j.user_action = 'applied' ORDER BY j.action_at DESC, j.id DESC LIMIT ?`,
      params: [limit],
    });
    return rows.map(toPendingJob);
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
