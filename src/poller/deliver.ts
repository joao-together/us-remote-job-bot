import { adapterFor } from "../core/ats/detect";
import type { Fetcher } from "../core/ats/types";
import { PENDING_MAX_AGE_MS, SEND_SPACING_MS, DELIVERY_TIME_BUDGET_MS } from "../core/config";
import { findExcludedWord, type LocationClass } from "../core/match/rules";
import type { Store } from "../core/store/db";
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
}

/** Only matching classes are ever pending; anything else (a null class) is shown as ambiguous. */
function alertClass(cls: LocationClass | null): AlertLocationClass {
  return cls === "us" || cls === "us_restricted" || cls === "mx" ? cls : "ambiguous";
}

/**
 * Sends every pending job, oldest first, to every recipient (the owner first, then active invited
 * users), with SEND_SPACING_MS between all Telegram sends. Each successful send gets a
 * `deliveries` row, so every recipient has their own message and Applied/Skip state.
 *
 * At-most-once: a job is marked `sending` before the first Telegram call and stays there if the
 * owner's send fails ambiguously. When the owner's send (the first) fails, the run stops, so an
 * outage costs at most one job; the rest stay pending for the next run. Once anyone has received
 * the job it is marked sent; a failure for any later recipient (e.g. one who blocked the bot) is
 * logged and skipped. Before the first job is claimed, getMe checks that Telegram is reachable,
 * so a full outage costs no job at all.
 *
 * Pause is re-checked before every send: /pause moves pending jobs to suppressed, and delivery
 * stops so nothing is sent after the owner paused mid-run.
 */
export async function deliver(deps: DeliverDeps): Promise<DeliverStats> {
  const { store, fetcher, telegram, ownerId, now, sleep, excludedWords } = deps;
  const stats: DeliverStats = { sent: 0, messagesSent: 0, excluded: 0, detailFailures: 0, gone: 0, sendFailures: 0 };
  let sentBefore = false;
  let telegramChecked = false;
  /** The owner first, then active invited users; loaded once, when the first job is claimed. */
  let recipients: string[] | undefined;

  const startedAt = now();
  for (const job of await store.listPending()) {
    // Stop between jobs once the budget is spent so the run ends cleanly; the rest stay pending.
    if (now() - startedAt >= DELIVERY_TIME_BUDGET_MS) break;
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

    recipients ??= await store.listRecipients(ownerId);

    const html = formatJobAlert(
      {
        title: job.title,
        companyName: job.companyName,
        locationText: job.locationText,
        locationClass: alertClass(job.locationClass),
        locationReason: job.locationReason ?? undefined,
        alsoMexico: job.locationAlsoMexico,
        salaryText: salaryText ?? undefined,
        postedAt: job.postedAt ?? undefined,
        applyUrl: job.applyUrl,
      },
      now(),
    );

    let ownerMessageId: number | null = null;
    let delivered = 0;
    let stop = false;
    for (const [index, userId] of recipients.entries()) {
      if (sentBefore) await sleep(SEND_SPACING_MS);
      sentBefore = true;

      let messageId: number;
      try {
        ({ messageId } = await telegram.sendMessage(userId, html, jobKeyboard(job.id)));
      } catch (err) {
        stats.sendFailures++;
        if (index === 0 && delivered === 0) {
          // The first recipient (the owner) failed and nobody has it yet: treat it like an
          // outage. A 4xx means Telegram rejected the message, so it is safe to retry next run.
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
    }
    if (stop) break;
  }

  return stats;
}
