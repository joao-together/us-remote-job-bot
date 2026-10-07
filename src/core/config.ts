// Tunables shared by the poller and the Worker.

/**
 * Max boards fetched at the same time by the poller. At 16, ~1,000 boards take roughly 1–3 minutes
 * (most answer in under 2 s; a dead board holds a slot for at most REQUEST_TIMEOUT_MS).
 */
export const FETCH_CONCURRENCY = 16;

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
 * D1 free plan allows 100,000 rows written and 5,000,000 rows read per day (verify at
 * https://developers.cloudflare.com/d1/platform/pricing/). A `jobs` insert costs ~5 rows
 * written (table + indexes + sqlite_sequence), so only jobs that match (or are excluded,
 * suppressed or duplicates) get a row; non-matching ids are stored compactly in
 * companies.seen_ids. Adding a company (seed SQL or scripts/expand-companies.ts) costs ~3 rows
 * and baselining it ~1 company-row write, so growing to ~1,000 companies costs a few thousand
 * rows once. Steady state (a run every 10 minutes = 144 runs/day) is one company-row write per
 * company whose board changed since the previous run, plus ~5 rows per new matching job. Boards
 * change a few to a few dozen times a day, so ~1,000 companies cost roughly 10k–30k rows/day;
 * the theoretical ceiling (every board changing every run) is 144k, so check the D1 dashboard
 * after growing the list. Reads: each run reads every polled company row (~1,000) plus matched
 * job rows, i.e. roughly 150k–300k rows/day.
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

/**
 * Max time one poller run spends sending alerts. Fetching ~1,000 boards takes a few minutes and
 * the Actions job times out at 12, so delivery stops between jobs after this and the next run
 * (10 minutes later) continues. A job killed mid-send is never resent, so ending cleanly matters.
 */
export const DELIVERY_TIME_BUDGET_MS = 6 * 60 * 1000;
