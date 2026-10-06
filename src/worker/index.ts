import type { WorkerEnv } from "./env";

export const WEBHOOK_PATH = "/telegram/webhook";

export default {
  async fetch(request: Request, _env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== WEBHOOK_PATH || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    return new Response("ok");
  },

  async scheduled(_controller: ScheduledController, _env: WorkerEnv): Promise<void> {},
} satisfies ExportedHandler<WorkerEnv>;
