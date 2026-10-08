import { REPORT_MAX_LISTED, REPORT_MAX_RECIPIENTS, REPORT_TZ_OFFSET_MIN } from "../core/config";
import type { AppliedJob, ReportStats, ReportWindow, Store } from "../core/store/db";
import { TelegramError, type TelegramClient } from "../core/telegram/client";
import { escapeHtml, truncate } from "../core/telegram/format";
import { errorMessage, redactSecrets } from "../core/util";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = REPORT_TZ_OFFSET_MIN * 60 * 1000;
const MAX_TITLE = 80;
const MAX_COMPANY = 40;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Epoch ms of 00:00 Brazil time (fixed REPORT_TZ_OFFSET_MIN) of the Brazil date containing `nowMs`. */
export function brazilDayStart(nowMs: number): number {
  const local = nowMs + OFFSET_MS;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - OFFSET_MS;
}

/** Epoch ms of Monday 00:00 Brazil time of the Brazil week containing `nowMs`. */
export function brazilWeekStart(nowMs: number): number {
  const day = brazilDayStart(nowMs);
  const weekday = new Date(day + OFFSET_MS).getUTCDay(); // 0 = Sunday
  return day - ((weekday + 6) % 7) * DAY_MS;
}

/** "Tuesday, Oct 6" for the Brazil date containing `at`. */
export function formatBrazilDate(at: number): string {
  const d = new Date(at + OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export type ReportPeriod = "today" | "yesterday";

/**
 * The window a report covers: "today" is the current Brazil date so far (the /report command);
 * "yesterday" is the whole previous Brazil date (the morning cron). "This week" always runs from
 * Monday 00:00 Brazil time of the current week up to now.
 */
export function reportWindow(period: ReportPeriod, now: number): ReportWindow {
  const today = brazilDayStart(now);
  const start = period === "today" ? today : today - DAY_MS;
  // The week containing the reported day, so Monday's report (about Sunday) still shows last week.
  return { start, end: start + DAY_MS, weekStart: brazilWeekStart(start) };
}

export interface ReportInput {
  period: ReportPeriod;
  /** Start of the reported Brazil day. */
  dayStart: number;
  stats: ReportStats;
  /** Applications in the window, newest first (may be fewer than stats.applied when capped). */
  applied: AppliedJob[];
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function formatReport({ period, dayStart, stats, applied }: ReportInput): string {
  const lines = [
    `<b>📊 Daily report — ${escapeHtml(formatBrazilDate(dayStart))}</b>`,
    `Applied ${period}: ${stats.applied}`,
    `This week: ${stats.appliedWeek} · All time: ${stats.appliedAll}`,
    `Skipped ${period}: ${stats.skipped}`,
    `Alerts received ${period}: ${stats.alerts}`,
    "",
  ];
  const total = Math.max(stats.applied, applied.length);
  if (total === 0) {
    lines.push(`No applications ${period} — new matching roles keep arriving every 10 minutes.`);
    return lines.join("\n");
  }
  lines.push(`<b>${capitalize(period)}'s applications:</b>`);
  const listed = applied.slice(0, REPORT_MAX_LISTED);
  listed.forEach((j, i) => {
    const title = escapeHtml(truncate(j.title, MAX_TITLE));
    const company = escapeHtml(truncate(j.companyName, MAX_COMPANY));
    lines.push(`${i + 1}. <a href="${escapeHtml(j.applyUrl)}">${title}</a> — ${company}`);
  });
  if (total > listed.length) lines.push(`…and ${total - listed.length} more`);
  return lines.join("\n");
}

/** Builds the report for one user (the owner also gets legacy applied jobs). */
export async function buildReport(store: Store, userId: string, ownerId: string, period: ReportPeriod, now: number): Promise<string> {
  const reports = await buildReports(store, [userId], ownerId, period, now);
  return reports.get(userId)!;
}

/** Builds reports for several users with two D1 queries in total. */
export async function buildReports(
  store: Store,
  userIds: readonly string[],
  ownerId: string,
  period: ReportPeriod,
  now: number,
): Promise<Map<string, string>> {
  const win = reportWindow(period, now);
  const [stats, applied] = await Promise.all([
    store.reportStats(userIds, win, ownerId),
    store.appliedBetween(userIds, win.start, win.end, { legacyUserId: ownerId, limitPerUser: REPORT_MAX_LISTED }),
  ]);
  const out = new Map<string, string>();
  for (const id of userIds) {
    out.set(id, formatReport({ period, dayStart: win.start, stats: stats.get(id)!, applied: applied.get(id) ?? [] }));
  }
  return out;
}

export interface DailyReportResult {
  sent: number;
  failed: number;
  /** Recipients left out by REPORT_MAX_RECIPIENTS. */
  skipped: number;
}

/**
 * Sends every recipient (owner first, then active invited users) their own report for the
 * previous Brazil day. One failed send (e.g. 403: the user blocked the bot) is logged and the
 * rest continue. At most REPORT_MAX_RECIPIENTS are processed per run (Worker subrequest limit).
 */
export async function runDailyReports(
  store: Store,
  telegram: Pick<TelegramClient, "sendMessage">,
  ownerId: string,
  now: number,
  secrets: (string | undefined)[] = [],
): Promise<DailyReportResult> {
  const all = await store.listRecipients(ownerId);
  const recipients = all.slice(0, REPORT_MAX_RECIPIENTS);
  const skipped = all.length - recipients.length;
  if (skipped > 0) {
    console.warn(`report: ${all.length} recipients, only the first ${REPORT_MAX_RECIPIENTS} get a report this run (${skipped} skipped)`);
  }
  const reports = await buildReports(store, recipients, ownerId, "yesterday", now);
  let sent = 0;
  let failed = 0;
  for (const userId of recipients) {
    try {
      await telegram.sendMessage(userId, reports.get(userId)!);
      sent++;
    } catch (err) {
      failed++;
      const detail = err instanceof TelegramError ? `${err.status} ${err.description}` : errorMessage(err);
      console.error(`report: sending to user ${userId} failed: ${redactSecrets(detail, ...secrets)}`);
    }
  }
  return { sent, failed, skipped };
}
