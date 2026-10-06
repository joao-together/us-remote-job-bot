// Entry point for the hourly GitHub Actions run (Node). Reads config from env.
import { Store } from "../core/store/db";
import { httpDriver } from "../core/store/driver-http";
import { TelegramClient } from "../core/telegram/client";
import { errorMessage, sleep } from "../core/util";
import { runPoll } from "./run";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const driver = httpDriver({
    accountId: requireEnv("CF_ACCOUNT_ID"),
    databaseId: requireEnv("CF_D1_DATABASE_ID"),
    apiToken: requireEnv("CF_D1_API_TOKEN"),
  });
  const telegram = new TelegramClient({ token: requireEnv("TELEGRAM_BOT_TOKEN"), waitOn429: true });
  const ownerId = requireEnv("OWNER_USER_ID");

  const stats = await runPoll({
    store: new Store(driver),
    fetcher: (input, init) => fetch(input, init),
    telegram,
    ownerId,
    now: Date.now,
    sleep,
  });

  console.log(
    `poll done: ${stats.companiesOk} companies ok, ${stats.companiesFailed} failed, ` +
      `${stats.newJobs} new jobs, ${stats.matched} matched, ${stats.sent} sent, ${stats.sendFailures} send failures`,
  );
}

main().catch((err: unknown) => {
  // Driver and Telegram errors are already token-redacted.
  console.error(`poll failed: ${errorMessage(err)}`);
  process.exit(1);
});
