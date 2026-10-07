// Tunables shared by the poller and the Worker.

/**
 * Max boards fetched at the same time by the poller. A run checks ~1,100 fast + ~1,350 wide boards
 * (see WIDE_SLOTS); at 24 in flight that takes roughly 2–4 minutes (most answer in under 2 s; a
 * dead board holds a slot for at most REQUEST_TIMEOUT_MS).
 */
export const FETCH_CONCURRENCY = 24;

/**
 * Wide-tier boards are split into this many groups by `id % WIDE_SLOTS`; each run (every
 * WIDE_SLOT_MS) checks one group, so every wide board is checked about once an hour. Fast-tier
 * boards are checked every run. Must match the `id % 6` expression index in
 * migrations/0004_tiers.sql (a different value stays correct but reads every wide row per run).
 */
export const WIDE_SLOTS = 6;

/** Length of one wide slot: the poller's schedule interval. */
export const WIDE_SLOT_MS = 10 * 60 * 1000;

/**
 * A fast board with no new matching job for this long (and added at least this long ago) is
 * moved to the wide tier by the weekly expansion run. A wide board is promoted back to fast as
 * soon as it yields a new matching job.
 */
export const DEMOTE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Watchdog: warn when more than this share of active fast-tier companies is failing. Wide-tier
 * boards (many small or rarely used boards) are flakier and are left out of the share.
 */
export const WATCHDOG_FAILING_SHARE = 0.25;

/** A company counts as failing after this many consecutive failed checks. */
export const FAILING_AFTER_CONSECUTIVE = 3;

/** Watchdog: minimum gap between repeated warnings. */
export const WATCHDOG_REWARN_MS = 6 * 60 * 60 * 1000;

/** Longest excluded word accepted by /exclude. */
export const MAX_EXCLUDED_WORD_LENGTH = 40;

/**
 * Statements per batch when writing to D1.
 *
 * D1 free plan: 100,000 rows written and 5,000,000 rows read per day (verify at
 * https://developers.cloudflare.com/d1/platform/pricing/). D1 counts index entries too, so a
 * `jobs` insert costs ~5 rows written and a `companies` insert ~4 (table, UNIQUE index, tier
 * index, sqlite_sequence). Only jobs that pass matching get a row; non-matching ids are stored
 * compactly in companies.seen_ids.
 *
 * Estimates for ~1,100 fast + ~8,000 wide boards, 144 runs/day (every 10 minutes):
 * - Reads per run ≈ fast rows + wide/WIDE_SLOTS rows + the not-yet-baselined batch, each read
 *   once through the companies_tier_slot index (measured: ~1 row read per selected row):
 *   1,100 + 1,350 ≈ 2,450; plus the stored job rows of the polled boards, read twice (known ids and
 *   repost candidates; nearly all belong to fast boards, J ≈ 1–3k after some months); plus a few
 *   settings rows. ≈ 2,450 + 2J ≈ 4.5k–8.5k/run ≈ 0.65M–1.2M/day. The hourly watchdog counts
 *   companies per tier (~11k index rows) ≈ 0.3M/day. Total ≈ 1–1.5M/day (20–30% of 5M); J is the
 *   term that grows. While a fresh expansion is being baselined, each run also sorts every
 *   not-yet-baselined row (≈2 reads each): ~9k boards add ≤18k reads/run for ~23 runs, ~0.3M once.
 * - Writes: one company-row write per polled board whose board changed since its last check
 *   (seen_ids), plus ~5 rows per new matching job and 1 last_match_at/tier update on that board.
 *   Fast boards: ~1,100 × a few to a few dozen changes/day ≈ 5k–25k. Wide boards are checked 24×
 *   a day, so each changes at most 24× a day; most are small or idle (~8,000 × ~0.5–2 ≈ 4k–16k),
 *   but a few hundred large non-matching boards may change nearly every hour (+5k–10k). Matches:
 *   ~20–60/day ≈ 0.5k; settings ~0.5k. Total ≈ 10k–50k/day steady state.
 * - One-off: inserting ~8,000 new boards ≈ 32k rows (measured 4 per insert) and baselining them
 *   (row + tier-index entry, measured 2 each) ≈ 16k over ~4 hours: ≈ 48k on top of a normal day,
 *   i.e. ~60k–100k on that day. If steady state is already above ~40k/day, split the first large
 *   expansion over two days with the workflow's target_total input.
 * - Weekly demotion and promotions: 2 rows per board that changes tier.
 * Check the D1 dashboard after growing the list.
 */
export const DB_BATCH_SIZE = 50;

export const USER_AGENT = "us-remote-job-bot/0.1 (personal job alert bot)";

/**
 * A pending job whose detail fetch keeps failing (not a 404) is sent without description/salary
 * enrichment once it has been pending this long, instead of waiting forever.
 */
export const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Max not-yet-baselined active companies (any tier) fetched per poller run, lowest ids first.
 * Spreads the first-run baseline D1 write burst over several runs (~9,000 new boards take ~23
 * runs, about 4 hours). pending_validation companies (from /add) are not capped.
 */
export const BASELINE_COMPANIES_PER_RUN = 400;

/**
 * Max time one poller run spends sending alerts. Fetching ~2,500–2,900 boards takes a few minutes
 * and the Actions job times out at 15, so delivery stops between jobs after this and the next run
 * (10 minutes later) continues. A job killed mid-send is never resent, so ending cleanly matters.
 */
export const DELIVERY_TIME_BUDGET_MS = 6 * 60 * 1000;
