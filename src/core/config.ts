// Tunables shared by the poller and the Worker.

/** Max boards fetched at the same time by the poller. */
export const FETCH_CONCURRENCY = 8;

/** Per-request timeout for job-board and Telegram calls. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Delay between Telegram sends to stay under ~1 message/second per chat. */
export const SEND_SPACING_MS = 1_100;

/** A new job id matching an earlier one (same title + location) within this window may be a repost. */
export const REPOST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** "Posted Xh ago" is shown only for posting dates newer than this. */
export const POSTED_AGO_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Watchdog: warn when the last successful poll is older than this. */
export const WATCHDOG_STALE_MS = 3 * 60 * 60 * 1000;

/** Watchdog: warn when more than this share of active companies is failing. */
export const WATCHDOG_FAILING_SHARE = 0.25;

/** A company counts as failing after this many consecutive failed checks. */
export const FAILING_AFTER_CONSECUTIVE = 3;

/** Watchdog: minimum gap between repeated warnings. */
export const WATCHDOG_REWARN_MS = 6 * 60 * 60 * 1000;

/** Longest excluded word accepted by /exclude. */
export const MAX_EXCLUDED_WORD_LENGTH = 40;

/**
 * Statements per batch when writing to D1.
 * D1 free plan allows 100,000 rows written per day (verify at
 * https://developers.cloudflare.com/d1/platform/pricing/). Seeding ~350 companies
 * writes roughly 55k rows once; steady state is ~10k/day.
 */
export const DB_BATCH_SIZE = 50;

export const USER_AGENT = "us-remote-job-bot/0.1 (personal job alert bot)";

/**
 * A pending job whose detail fetch keeps failing (not a 404) is sent without description/salary
 * enrichment once it has been pending this long, instead of waiting forever.
 */
export const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Max not-yet-baselined active companies fetched per poller run. Spreads the first-run baseline
 * D1 write burst over several runs. pending_validation companies (from /add) are not capped.
 */
export const BASELINE_COMPANIES_PER_RUN = 60;
