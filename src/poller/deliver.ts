import { adapterFor } from "../core/ats/detect";
import type { Fetcher } from "../core/ats/types";
import { SEND_SPACING_MS } from "../core/config";
import { classifyLocation, findExcludedWord, type LocationClass } from "../core/match/rules";
import type { PendingJob, Store } from "../core/store/db";
import { TelegramError, type TelegramClient } from "../core/telegram/client";
import { formatJobAlert, jobKeyboard, type LocationClass as AlertLocationClass } from "../core/telegram/format";

export type Sender = Pick<TelegramClient, "sendMessage">;

export interface DeliverDeps {
  store: Store;
  fetcher: Fetcher;
  telegram: Sender;
  ownerId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  excludedWords: string[];
}

export interface DeliverStats {
  sent: number;
  excluded: number;
  /** Jobs left pending because their detail fetch failed. */
  detailFailures: number;
  sendFailures: number;
}

const ALERT_CLASSES: readonly string[] = ["us", "us_restricted", "ambiguous"];

/**
 * Only the class is stored, so the warning reason is recomputed from the location text.
 * When neither remote reading reproduces the stored class, the formatter's generic reason is used.
 */
export function alertLocation(job: Pick<PendingJob, "locationText" | "locationClass">): {
  locationClass: AlertLocationClass;
  locationReason?: string;
} {
  const cls = (ALERT_CLASSES.includes(job.locationClass ?? "") ? job.locationClass : "ambiguous") as AlertLocationClass;
  if (cls === "us") return { locationClass: cls };
  for (const remote of ["yes", "unknown"] as const) {
    const res = classifyLocation({ locationText: job.locationText, remote, countryCodes: [] });
    if (res.cls === (cls as LocationClass)) return { locationClass: cls, locationReason: res.reason };
  }
  return { locationClass: cls };
}

/**
 * Sends every pending job, oldest first. At-most-once: a job is marked `sending` before the
 * Telegram call and stays there if the call fails. After a send failure the run stops, so an
 * outage costs at most one job; the rest stay pending for the next run.
 */
export async function deliver(deps: DeliverDeps): Promise<DeliverStats> {
  const { store, fetcher, telegram, ownerId, now, sleep, excludedWords } = deps;
  const stats: DeliverStats = { sent: 0, excluded: 0, detailFailures: 0, sendFailures: 0 };
  let sentBefore = false;

  for (const job of await store.listPending()) {
    let description = "";
    let salaryText = job.salaryText;

    const fetchDetail = adapterFor(job.ats).fetchDetail;
    if (fetchDetail) {
      const detail = await fetchDetail(job.boardToken, job.boardJobId, fetcher);
      if (!detail.ok) {
        stats.detailFailures++;
        continue;
      }
      description = detail.value.description;
      if (detail.value.salaryText && detail.value.salaryText !== job.salaryText) {
        salaryText = detail.value.salaryText;
        await store.updateJobDetail(job.id, { salaryText });
      }
    }

    if (findExcludedWord(`${job.title}\n${description}`, excludedWords)) {
      await store.markExcluded(job.id);
      stats.excluded++;
      continue;
    }

    if (!(await store.markSending(job.id))) continue;

    if (sentBefore) await sleep(SEND_SPACING_MS);
    sentBefore = true;

    const html = formatJobAlert(
      {
        title: job.title,
        companyName: job.companyName,
        locationText: job.locationText,
        ...alertLocation(job),
        salaryText: salaryText ?? undefined,
        postedAt: job.postedAt ?? undefined,
        applyUrl: job.applyUrl,
      },
      now(),
    );

    let messageId: number;
    try {
      ({ messageId } = await telegram.sendMessage(ownerId, html, jobKeyboard(job.id)));
    } catch (err) {
      stats.sendFailures++;
      console.error(`send failed for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      // A 4xx means Telegram rejected the message, so it is safe to retry next run.
      // Network errors and 5xx are ambiguous: keep 'sending' so it is never sent twice.
      if (err instanceof TelegramError && err.status >= 400 && err.status < 500) {
        await store.revertSending(job.id);
      }
      break;
    }
    await store.markSent(job.id, messageId, now());
    stats.sent++;
  }

  return stats;
}
