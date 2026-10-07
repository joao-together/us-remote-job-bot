# US Remote Job Bot

A private Telegram bot that checks the public job boards of ~280 remote-friendly companies every 10 minutes and sends you each new **senior, US-remote software engineering** role, with a direct apply link and ✅ Applied / ❌ Skip buttons.

It reads Greenhouse, Lever, Ashby and Workable job boards directly (the same sources paid job aggregators scrape) and runs entirely on free tiers:

| Part | Runs on | Does |
|---|---|---|
| Poller | GitHub Actions, started every 10 min by the Worker (public repo, unlimited free minutes) | Fetches boards, matches jobs, sends alerts |
| Bot | Cloudflare Worker | Commands, button taps, watchdog warnings |
| Storage | Cloudflare D1 | Companies, seen jobs, invited users, per-user deliveries, settings |

## Setup

You need: a Telegram account, a free Cloudflare account, a GitHub account, and Node 22+.

### 1. Create the Telegram bot

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and save the **bot token**.
2. Message [@userinfobot](https://t.me/userinfobot) to get your numeric **user id**.
3. Open a chat with your new bot and press **Start** (bots can't message you first).

### 2. Create the database

```bash
npm install
npx wrangler login
npx wrangler d1 create jobbot
```

Copy the printed `database_id` into `wrangler.toml`, then:

```bash
npm run db:migrate:remote
npx wrangler d1 execute jobbot --remote --file seed/companies.sql
```

### 3. Deploy the Worker

Generate a webhook secret (letters, digits, `_` and `-` only):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OWNER_USER_ID
npm run deploy
```

Register the webhook (replace the three values; the URL is printed by `deploy`):

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d url="https://<your-worker>.workers.dev/telegram/webhook" \
  -d secret_token="<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query"]'
```

Send `/status` to the bot — it should reply.

### 4. Set up the hourly poller

1. Push this repo to a **public** GitHub repository (secrets stay hidden; public repos get unlimited Actions minutes, which a 10-minute schedule needs). The workflow re-enables itself each run so GitHub's 60-day inactivity rule doesn't switch it off. For a private repo, change the cron to every 30 minutes to stay within 2,000 free minutes/month.
2. Create a Cloudflare API token at *My Profile → API Tokens → Create Token → Custom token* with only **Account → D1 → Edit**.
3. In the GitHub repo, add these *Settings → Secrets and variables → Actions* secrets:

| Secret | Value |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account id (dashboard sidebar) |
| `CF_D1_DATABASE_ID` | the `database_id` from step 2 |
| `CF_D1_API_TOKEN` | the D1-only API token |
| `TELEGRAM_BOT_TOKEN` | bot token |
| `OWNER_USER_ID` | your user id |

4. Run *Actions → Poll job boards → Run workflow* once. The first runs record every currently open job **silently** (60 companies per run, so the full list is baselined within ~30–60 minutes); alerts for a company start with jobs posted after its baseline.

## Using the bot

| Command | What it does |
|---|---|
| `/status` | Last check, companies watched/failing, jobs sent today |
| `/add <link>` | Watch a company, e.g. `/add https://jobs.lever.co/acme`. Confirmed within the hour. |
| `/remove <name>` | Stop watching a company (`/remove lever:acme` if the name is ambiguous) |
| `/companies` | List watched companies (⚠️ = failing) |
| `/exclude add <word>` | Hide jobs mentioning a word or phrase (title or description) |
| `/exclude remove <word>` / `/exclude list` | Manage excluded words |
| `/pause` / `/resume` | Stop/start alerts. Jobs found while paused are never sent later. |
| `/applied` | Your last 20 jobs marked ✅ Applied |
| `/invite <id>` / `/revoke <id>` / `/users` | Give someone the alerts, take them away, list who has them (see below) |

Each alert shows the title, company, location, salary (when the board lists it), how long ago it was posted, and the apply link (tap to open, long-press to copy). A ⚠️ under the location means the posting doesn't clearly say US (e.g. just "Remote") or is limited to some states — check before applying.

**What counts as a match:** remote, US-eligible (or flagged ambiguous), software engineering titles (backend, frontend, full stack, mobile, …) at Senior / Sr. / Lead level. Staff, Principal, junior and management roles are excluded.

### Inviting people

The bot is private: only you (`OWNER_USER_ID`) and people you invite can use it, and only in a private chat with the bot.

1. Ask them to open the bot in Telegram and press **Start**. The bot replies once with their numeric user id ("This bot is private. Your Telegram user id is …"), and you get a one-time notice: *Access request from Name (@username) — id 123456789. Tap to allow: /invite 123456789* (tap the command to copy it). Later messages from them are ignored silently, so nobody can spam you.
2. Send `/invite <id>`. They get a welcome message. If you see *"Added, but they need to open the bot and press Start…"*, Telegram refused because they've never started the bot — ask them to press Start; alerts will reach them from then on.
3. `/users` lists everyone invited (name, id, date added). `/revoke <id>` stops their alerts right away; if they write again they're ignored. `/invite` the same id to re-add them.

What invited people get:

- **The same job alerts as you**, each with its own ✅ Applied / ❌ Skip buttons. Their taps and their `/applied` list are their own and never change yours.
- `/start`, `/help`, `/status` and `/applied`. Everything else — `/add`, `/remove`, `/companies`, `/exclude`, `/pause`, `/resume`, `/invite`, `/revoke`, `/users` — is owner-only and answers *"Only the owner can do that."*
- Settings are global: `/pause` and excluded words apply to everyone. Watchdog warnings and `/add` confirmations go to you only.

If someone blocks the bot, the poller logs the failed send and carries on with everyone else.

## Troubleshooting

- **"No successful job check for Xh"** — the Worker's hourly watchdog didn't see a poller run. Check *Actions → Poll job boards*: workflow disabled, minutes exhausted, or a wrong secret.
- **"N of M companies are failing"** — `/companies` shows which. Boards move or close; `/remove` them or re-add with the new link.
- **Free-tier limits relied on:** GitHub Actions 2,000 min/month (private), D1 100k rows written/day, Workers 100k requests/day.

## Rotating secrets

- **Bot token leaked:** `/revoke` in @BotFather, then update `TELEGRAM_BOT_TOKEN` in both Wrangler (`npx wrangler secret put`) and GitHub, and re-run `setWebhook`.
- **Webhook secret:** generate a new one, `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, re-run `setWebhook`.
- **Cloudflare API token:** roll it in the dashboard and update `CF_D1_API_TOKEN` in GitHub.

## Development

```bash
npm test            # Vitest in the Workers runtime (no network)
npm run typecheck
npm run poll        # run the poller locally (needs the five env vars above)
npm run seed:build  # rebuild seed/companies.{json,sql} from public lists
```
