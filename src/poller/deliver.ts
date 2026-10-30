import { adapterFor } from "../core/ats/detect";
import type { Fetcher } from "../core/ats/types";
import { PENDING_MAX_AGE_MS, SEND_SPACING_MS, DELIVERY_TIME_BUDGET_MS } from "../core/config";
import { findExcludedWord, routeCountries, type Country, type LocationClass } from "../core/match/rules";
import type { PendingJob, Recipient, Store } from "../core/store/db";
import { TelegramError, type TelegramClient } from "../core/telegram/client";
import { type AlertLocationClass, formatJobAlert, jobKeyboard } from "../core/telegram/format";
import { errorMessage, redactSecrets } from "../core/util";

export type Sender = Pick<TelegramClient, "sendMessage" | "getMe">;

export interface DeliverDeps {
  store: Store;
  fetcher: Fetcher;
  telegram: Sender;
  ownerId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Excluded words as returned by prepareExcludedWords. */
  excludedWords: readonly (readonly string[])[];
}

export interface DeliverStats {
  /** Jobs that reached at least one recipient. */
  sent: number;
  /** Alert messages sent, across all recipients. */
  messagesSent: number;
  excluded: number;
  /** Jobs left pending because their detail fetch failed. */
  detailFailures: number;
  /** Pending jobs whose posting was gone from the board (detail 404), marked seen. */
  gone: number;
  /** Failed alert sends, across all recipients. */
  sendFailures: number;
  /** Jobs no recipient's countries match: marked sent without any message. */
  unrouted: number;
}

/** Only matching classes are ever pending; anything else (a null class) is shown as ambiguous. */
function alertClass(cls: LocationClass | null): AlertLocationClass {
  return cls === "us" || cls === "us_restricted" || cls === "intl" ? cls : "ambiguous";
}

/**
 * Who gets this job, in recipient order: everyone whose countries include one the job is open to
 * (LATAM-wide counts as Mexico, Colombia and Argentina; Europe/EMEA-wide as the UK). A job with
 * no stored countries (no class) is shown as US-ambiguous, so it goes to US recipients.
 */
export function routeJob(
  job: Pick<PendingJob, "locationCountries" | "locationLatam"> & Partial<Pick<PendingJob, "locationEmea">>,
  recipients: readonly Recipient[],
): string[] {
  let route = routeCountries(job.locationCountries, job.locationLatam, job.locationEmea ?? false);
  if (route.size === 0) route = new Set<Country>(["US"]);
  return recipients.filter((r) => r.countries.some((c) => route.has(c))).map((r) => r.userId);
}

/** Telegram refused this chat (blocked the bot, never pressed Start): retrying won't help. */
function chatRejected(err: unknown): boolean {
  return err instanceof TelegramError && (err.status === 403 || err.status === 400);
}

/**
 * Sends every pending job, oldest first, to every recipient whose countries match it (the owner
 * first, then active invited users; see routeJob), with SEND_SPACING_MS between all Telegram
 * sends. Each successful send gets a `deliveries` row, so every recipient has their own message
 * and Applied/Skip state. Recipients and their countries are read once per run, in one query.
 * A job no recipient's countries match is marked sent with no message and no deliveries row
 * (terminal, like any sent job: never sent later, even if someone selects that country).
 *
 * At-most-once: a job is marked `sending` before the first Telegram call and stays there if the
 * first send fails ambiguously. When the first send fails before anyone has the job, the run
 * stops, so an outage costs at most one job; the rest stay pending for the next run. The one
 * exception is a member whose chat Telegram refuses (403/400: blocked the bot, never pressed
 * Start): they are skipped like any later failure, so they can't hold up a job routed only to
 * them; if every recipient of a job is refused that way it is marked sent, undelivered. Once
 * anyone has received the job it is marked sent; a failure for any later recipient is logged and
 * skipped. Before the first job is claimed, getMe checks that Telegram is reachable, so a full
 * outage costs no job at all.
 *
 * Pause is re-checked before every send: /pause moves pending jobs to suppressed, and delivery
 * stops so nothing is sent after the owner paused mid-run.
 */
export async function deliver(deps: DeliverDeps): Promise<DeliverStats> {
  const { store, fetcher, telegram, ownerId, now, sleep, excludedWords } = deps;
  const stats: DeliverStats = { sent: 0, messagesSent: 0, excluded: 0, detailFailures: 0, gone: 0, sendFailures: 0, unrouted: 0 };
  let sentBefore = false;
  let telegramChecked = false;
  /** The owner first, then active invited users, with their countries; loaded once per run. */
  let recipients: Recipient[] | undefined;

  const startedAt = now();
  for (const job of await store.listPending()) {
    // Stop between jobs once the budget is spent so the run ends cleanly; the rest stay pending.
    if (now() - startedAt >= DELIVERY_TIME_BUDGET_MS) break;

    recipients ??= await store.listRecipientsWithCountries(ownerId);
    const route = routeJob(job, recipients);
    if (route.length === 0) {
      // Nobody selected a country this job is open to: retire it without fetching or sending.
      await store.markSent(job.id, null, now());
      stats.unrouted++;
      continue;
    }

    let description = "";
    let salaryText = job.salaryText;

    const fetchDetail = adapterFor(job.ats).fetchDetail;
    if (fetchDetail) {
      const detail = await fetchDetail(job.boardToken, job.boardJobId, fetcher);
      if (detail.ok) {
        description = detail.value.description;
        if (detail.value.salaryText && detail.value.salaryText !== job.salaryText) {
          salaryText = detail.value.salaryText;
          await store.updateJobDetail(job.id, { salaryText });
        }
      } else if (detail.kind === "not_found") {
        // The posting vanished before we could send it: retire it instead of retrying forever.
        await store.markGone(job.id);
        stats.gone++;
        continue;
      } else if (now() - job.firstSeenAt <= PENDING_MAX_AGE_MS) {
        stats.detailFailures++;
        continue;
      }
      // Otherwise the detail has failed for too long: send without enrichment (title-only exclusion check).
    }

    if (findExcludedWord(`${job.title}\n${description}`, excludedWords)) {
      await store.markExcluded(job.id);
      stats.excluded++;
      continue;
    }

    if (await store.isPaused()) break;

    if (!telegramChecked) {
      try {
        await telegram.getMe();
      } catch (err) {
        stats.sendFailures++;
        console.error(`Telegram unreachable, skipping delivery: ${errorMessage(err)}`);
        break;
      }
      telegramChecked = true;
    }

    if (!(await store.markSending(job.id))) continue;

    const html = formatJobAlert(
      {
        title: job.title,
        companyName: job.companyName,
        locationText: job.locationText,
        locationClass: alertClass(job.locationClass),
        locationReason: job.locationReason ?? undefined,
        countries: job.locationCountries,
        latam: job.locationLatam,
        emea: job.locationEmea,
        salaryText: salaryText ?? undefined,
        postedAt: job.postedAt ?? undefined,
        applyUrl: job.applyUrl,
      },
      now(),
    );

    let ownerMessageId: number | null = null;
    let delivered = 0;
    let stop = false;
    for (const [index, userId] of route.entries()) {
      if (sentBefore) await sleep(SEND_SPACING_MS);
      sentBefore = true;

      let messageId: number;
      try {
        ({ messageId } = await telegram.sendMessage(userId, html, jobKeyboard(job.id, undefined, { applyUrl: job.applyUrl })));
      } catch (err) {
        stats.sendFailures++;
        if (delivered === 0 && (userId === ownerId || !chatRejected(err))) {
          // Nobody has it yet and this isn't one member's refused chat: treat it like an outage.
          // A 4xx means Telegram rejected the message, so it is safe to retry next run.
          // Network errors and 5xx are ambiguous: keep 'sending' so it is never sent twice.
          console.error(`send failed for job ${job.id}: ${redactSecrets(errorMessage(err), userId)}`);
          if (err instanceof TelegramError && err.status >= 400 && err.status < 500) {
            await store.revertSending(job.id);
          }
          stop = true;
          break;
        }
        // One recipient failing (e.g. 403: blocked the bot / never pressed Start) must not stop
        // the others. Logs are public (GitHub Actions), so the user id is never logged.
        console.error(`send to recipient #${index + 1} failed for job ${job.id}: ${redactSecrets(errorMessage(err), userId)}`);
        continue;
      }
      if (userId === ownerId) ownerMessageId = messageId;
      await store.recordDelivery(job.id, userId, messageId, now());
      delivered++;
      stats.messagesSent++;
    }

    if (delivered > 0) {
      await store.markSent(job.id, ownerMessageId, now());
      stats.sent++;
    } else if (!stop) {
      // Every recipient's chat refused it (see chatRejected): retrying would only repeat that.
      await store.markSent(job.id, null, now());
    }
    if (stop) break;
  }

  return stats;
}
