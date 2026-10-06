// Entry point for the hourly GitHub Actions run (Node). Reads config from env.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  requireEnv("CF_ACCOUNT_ID");
  requireEnv("CF_D1_DATABASE_ID");
  requireEnv("CF_D1_API_TOKEN");
  requireEnv("TELEGRAM_BOT_TOKEN");
  requireEnv("OWNER_USER_ID");
  console.log("poller: not implemented yet");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
