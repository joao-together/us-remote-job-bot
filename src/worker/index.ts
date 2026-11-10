import { Store } from "../core/store/db";
import { bindingDriver } from "../core/store/driver-binding";
import { TelegramClient, TelegramError } from "../core/telegram/client";
import { inActiveHours, redactSecrets } from "../core/util";
import { handleUpdate } from "./commands";
import {
  dispatchWorkflow,
  dispatchWorkflowStatus,
  EXPAND_CRON,
  EXPAND_WORKFLOW,
  POLL_CRON,
  POLL_WORKFLOW,
  REPORT_CRON,
  WATCHDOG_CRON,
} from "./dispatch";
import type { WorkerEnv } from "./env";
import { runDailyReports } from "./report";
import { runWatchdog } from "./watchdog";

export const WEBHOOK_PATH = "/telegram/webhook";
export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

const encoder = new TextEncoder();

/** Compares in time that depends only on the expected secret's length. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= (a.length > 0 ? a[i % a.length]! : 0) ^ b[i]!;
  }
  return diff === 0 && b.length > 0;
}

const ok = () => new Response("ok");

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET || !env.OWNER_USER_ID) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!secretsMatch(request.headers.get(SECRET_HEADER) ?? "", env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    try {
      await handleUpdate(update, {
        store: new Store(bindingDriver(env.DB)),
        telegram: new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN }),
        ownerId: env.OWNER_USER_ID,
        now: Date.now,
      });
    } catch (err) {
      const detail = err instanceof TelegramError ? `${err.status} ${err.description}` : err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
      console.error(`webhook: handling update failed: ${redactSecrets(detail, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET)}`);
    }
    return ok();
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const github = { token: env.GITHUB_DISPATCH_TOKEN, repo: env.GITHUB_REPO };
    if (controller.cron === EXPAND_CRON) {
      await dispatchWorkflow(github, EXPAND_WORKFLOW);
      return;
    }
    if (controller.cron === REPORT_CRON || controller.cron === WATCHDOG_CRON) {
      const store = new Store(bindingDriver(env.DB));
      const telegram = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN });
      if (controller.cron === REPORT_CRON) {
        await runDailyReports(store, telegram, env.OWNER_USER_ID, controller.scheduledTime, [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET]);
      } else {
        await runWatchdog(store, telegram, env.OWNER_USER_ID, controller.scheduledTime);
      }
      return;
    }
    // POLL_CRON — and any other or stale cron (Cloudflare kept firing an old "*/10" after it was
    // replaced by "*/15", which silently stopped polling) — starts the poller. A stale cron firing
    // outside active hours (e.g. the old round-the-clock "*/15 * * * *") does nothing.
    if (controller.cron !== POLL_CRON) {
      if (!inActiveHours(controller.scheduledTime)) {
        console.log(`scheduled: unknown cron "${controller.cron}" outside active hours (08:00–24:00 UTC), not polling`);
        return;
      }
      console.log(`scheduled: unknown cron "${controller.cron}", treating as poll`);
    }
    const status = await dispatchWorkflowStatus(github, POLL_WORKFLOW);
    if (status === 401 || status === 403) await alertDispatchAuth(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<WorkerEnv>;

/** Minimum gap between "dispatch token rejected" messages to the owner. */
export const DISPATCH_ALERT_REWARN_MS = 6 * 60 * 60 * 1000;

export const DISPATCH_AUTH_ALERT =
  "⚠️ <b>Job checks are stopped</b>: GitHub rejected the bot's dispatch token (expired or revoked).\n\n" +
  "Fix: create a new fine-grained token at https://github.com/settings/personal-access-tokens/new " +
  "(repository <code>us-remote-job-bot</code> only, permission <b>Actions: Read and write</b>, no expiration), then run " +
  "<code>npx wrangler secret put GITHUB_DISPATCH_TOKEN</code> in the project folder.";

/** Tells the owner (at most every DISPATCH_ALERT_REWARN_MS) that polling is blocked by a bad GitHub token. */
async function alertDispatchAuth(env: WorkerEnv, now: number): Promise<void> {
  try {
    const store = new Store(bindingDriver(env.DB));
    const { lastDispatchAlertAt } = await store.getSettings();
    if (lastDispatchAlertAt !== undefined && now - lastDispatchAlertAt < DISPATCH_ALERT_REWARN_MS) return;
    await new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN }).sendMessage(env.OWNER_USER_ID, DISPATCH_AUTH_ALERT);
    await store.setSetting("last_dispatch_alert_at", now);
  } catch (err) {
    const detail = err instanceof TelegramError ? `${err.status} ${err.description}` : err instanceof Error ? err.message : "unknown";
    console.error(`dispatch auth alert failed: ${redactSecrets(detail, env.TELEGRAM_BOT_TOKEN)}`);
  }
}
