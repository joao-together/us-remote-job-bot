import { WATCHDOG_FAILING_SHARE, WATCHDOG_REWARN_MS, WATCHDOG_STALE_MS, WATCHDOG_WINDOW_GRACE_MS } from "../core/config";
import { type CompanyRow, type HealthCounts, type PollStats, type Settings, type StatusCounts, Store, utcMidnight } from "../core/store/db";
import { activeWindowStart } from "../core/util";
import { TelegramError, type TelegramClient } from "../core/telegram/client";
import { escapeHtml } from "../core/telegram/format";

const MAX_FAILING_LISTED = 10;

export interface HealthInput {
  settings: Settings;
  counts: HealthCounts;
  now: number;
}

/** Shown in /status; keep in sync with ACTIVE_HOURS_UTC and POLL_CRON. */
export const SCHEDULE_TEXT = "Checks run every 15 min, 09:00–21:00 Brazil time (12:00–24:00 UTC)";

export function formatAgo(at: number | undefined, now: number): string {
  if (at === undefined) return "never";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function evaluateHealth({ settings, counts, now }: HealthInput): { warnings: string[] } {
  const warnings: string[] = [];
  const last = settings.lastSuccessfulPollAt;
  const neverPolled = last === undefined && settings.lastPollStartAt === undefined;
  const freshInstall = neverPolled && !counts.anyActive;

  // Polls run only in active hours, so staleness is judged only then, from WATCHDOG_WINDOW_GRACE_MS
  // after the window opens, and counts only time inside today's window.
  const windowStart = activeWindowStart(now);
  const judgeStaleness = windowStart !== undefined && now - windowStart >= WATCHDOG_WINDOW_GRACE_MS;
  const staleSince = last === undefined || windowStart === undefined ? undefined : Math.max(last, windowStart);
  if (judgeStaleness && !freshInstall && (staleSince === undefined || now - staleSince > WATCHDOG_STALE_MS)) {
    const since = last === undefined ? "yet" : `for ${Math.floor((now - last) / 3_600_000)}h`;
    warnings.push(
      `⚠️ No successful job check ${since}. Check the GitHub Actions 'Poll job boards' workflow (disabled? out of minutes? bad secret?).`,
    );
  }
  // Share of the fast tier only: wide boards are many small, rarely matching boards and flakier.
  if (counts.fast > 0 && counts.failing / counts.fast > WATCHDOG_FAILING_SHARE) {
    warnings.push(`⚠️ ${counts.failing} of ${counts.fast} fast-checked companies are failing. Send /status to see which.`);
  }
  return { warnings };
}

export async function runWatchdog(
  store: Store,
  telegram: Pick<TelegramClient, "sendMessage">,
  ownerId: string,
  now: number,
): Promise<{ sent: boolean }> {
  const [settings, counts] = await Promise.all([store.getSettings(), store.healthCounts()]);
  const { warnings } = evaluateHealth({ settings, counts, now });
  if (warnings.length === 0) return { sent: false };
  if (settings.lastWarningAt !== undefined && now - settings.lastWarningAt < WATCHDOG_REWARN_MS) return { sent: false };

  try {
    await telegram.sendMessage(ownerId, warnings.map(escapeHtml).join("\n\n"));
  } catch (err) {
    const detail = err instanceof TelegramError ? `${err.status} ${err.description}` : err instanceof Error ? err.name : "unknown";
    console.error(`watchdog: sending warning failed: ${detail}`);
    return { sent: false };
  }
  await store.setSetting("last_warning_at", now);
  return { sent: true };
}

export interface StatusInput {
  settings: Settings;
  counts: StatusCounts;
  failing: CompanyRow[];
  now: number;
}

export function formatStatus({ settings, counts, failing, now }: StatusInput): string {
  const lines = [
    "<b>Status</b>",
    settings.paused ? "⏸ Paused. Send /resume to get alerts again." : "▶️ Running.",
    `Last check: ${formatAgo(settings.lastPollStartAt, now)}`,
    `Last successful check: ${formatAgo(settings.lastSuccessfulPollAt, now)}`,
    SCHEDULE_TEXT,
    "",
    `Companies: ${counts.fast} fast (every 15 min), ${counts.wide} wide (every 90 min)`,
    `Fast companies failing: ${counts.failing}`,
  ];
  if (failing.length > 0) {
    const names = failing.slice(0, MAX_FAILING_LISTED).map((c) => escapeHtml(c.name));
    const more = failing.length > MAX_FAILING_LISTED ? ` and ${failing.length - MAX_FAILING_LISTED} more` : "";
    lines.push(`  ${names.join(", ")}${more}`);
  }
  lines.push(
    `Companies waiting for validation: ${counts.pendingValidation}`,
    "",
    `Jobs sent today: ${counts.sentToday}`,
    `Jobs waiting to send: ${counts.pending}`,
  );
  const stats: PollStats | undefined = settings.lastPollStats;
  if (stats) {
    lines.push(
      `Last poll: ${num(stats.companiesOk)} boards ok, ${num(stats.companiesFailed)} failed, ${num(stats.sent)} jobs sent`,
    );
  }
  return lines.join("\n");
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function buildStatus(store: Store, now: number): Promise<string> {
  const [settings, counts, failing] = await Promise.all([
    store.getSettings(),
    store.statusCounts(utcMidnight(now)),
    store.failingCompanies(),
  ]);
  return formatStatus({ settings, counts, failing, now });
}
