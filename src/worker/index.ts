import { Store } from "../core/store/db";
import { bindingDriver } from "../core/store/driver-binding";
import { TelegramClient, TelegramError } from "../core/telegram/client";
import { handleUpdate } from "./commands";
import type { WorkerEnv } from "./env";
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
      console.error(`webhook: handling update failed: ${detail}`);
    }
    return ok();
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const store = new Store(bindingDriver(env.DB));
    const telegram = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN });
    await runWatchdog(store, telegram, env.OWNER_USER_ID, Date.now());
  },
} satisfies ExportedHandler<WorkerEnv>;
