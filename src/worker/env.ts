export interface WorkerEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_USER_ID: string;
  /** Fine-grained GitHub token (this repo only, Actions: write) used to start the poller. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** "owner/repo" of the poller workflow. */
  GITHUB_REPO?: string;
}
