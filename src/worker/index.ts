import { Store } from "../core/store/db";
import { bindingDriver } from "../core/store/driver-binding";
import { TelegramClient } from "../core/telegram/client";
import type { WorkerEnv } from "./env";
import { runWatchdog } from "./watchdog";

export const WEBHOOK_PATH = "/telegram/webhook";

export default {
  async fetch(request: Request, _env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    return new Response("ok");
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const store = new Store(bindingDriver(env.DB));
    const telegram = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN });
    await runWatchdog(store, telegram, env.OWNER_USER_ID, Date.now());
  },
} satisfies ExportedHandler<WorkerEnv>;
