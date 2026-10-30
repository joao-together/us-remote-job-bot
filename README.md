# US Remote Job Bot

A private Telegram bot that watches the public job boards of every company it can find on Greenhouse, Lever, Ashby and Workable (~9,000 live boards once expanded) and sends you each new **US-remote software engineering** role (mid-level and up, including DevOps/SRE, platform, data and ML engineering), with a direct apply link and ✅ Applied / ❌ Skip buttons.

It reads Greenhouse, Lever, Ashby and Workable job boards directly (the same sources paid job aggregators scrape) and runs entirely on free tiers:

| Part | Runs on | Does |
|---|---|---|
| Poller | GitHub Actions, started every 15 min from 09:00 to 21:00 Brazil time by the Worker (public repo, unlimited free minutes) | Fetches boards, matches jobs, sends alerts |
| Company list | GitHub Actions, started weekly by the Worker | Adds new live boards, moves quiet boards to the wide tier (every 90 min) |
| Bot | Cloudflare Worker | Commands, button taps, watchdog warnings, starting the two workflows |
| Storage | Cloudflare D1 | Companies, seen jobs, invited users, per-user deliveries, settings |

## How it works

- **Active hours.** Boards are checked only 08:00–24:00 UTC = **05:00–21:00 Brazil time** (BRT has no daylight saving; that is 04:00–20:00 US Eastern in summer, 03:00–19:00 in winter, and 09:00–01:00 UK summer time). Nothing is polled overnight; roles posted then are picked up by the first run of the day. The window is `ACTIVE_HOURS_UTC` in `src/core/config.ts` (keep `POLL_CRON` and `wrangler.toml` in sync).
- **Two tiers.** Every company is either **fast** or **wide**. Fast boards — the ones that have produced a matching role recently — are checked on every run, every 15 minutes during active hours. Wide boards (thousands of boards that rarely or never post a matching role) are split into 6 groups by id and one group is checked per run, so each is checked about **every 90 minutes** during active hours.
- **Promotion.** The moment a wide board posts a new role that passes the match rules, you get the alert and the board becomes fast.
- **Demotion.** Once a week, fast boards with no new matching role in 30 days (and added more than 30 days ago) become wide. Boards you `/add` start fast.
- **Each run** (Store.listCompaniesForRun) checks: all fast boards, this 15-minute slot's wide boards, boards waiting for `/add` validation, and up to 400 newly added boards that still need their silent baseline. With ~1,100 fast and ~8,000 wide boards that is ~2,450 boards per run, about 3–5 minutes at 24 requests in flight.
- **Schedules** come from the Worker's cron triggers (GitHub's own scheduler is unreliable): `*/15 8-23 * * *` starts *Poll job boards* (every 15 min, 08:00–23:45 UTC), `43 * * * *` runs the watchdog, `0 6 * * 1` (Mondays 06:00 UTC) starts *Expand company list*, `0 12 * * *` (09:00 Brazil time) sends the daily report. Any other (stale) cron still starts a poll inside active hours and does nothing outside them.
- **Watchdog.** Every hour it warns if more than 25% of fast boards are failing, and — only during active hours, from 90 minutes after the window opens — if no check has succeeded for 3 hours of active time (a last success from before today's window counts from the window's start).
- **Free tiers.** D1 reads follow what changed: the polled company rows (one index serves every part of the selection), plus `jobs` lookups only for ids a board lists that aren't already in its seen-ids list, plus repost checks only for boards with a new matching role — roughly 3k–4k rows per run, 0.2–0.3M rows read and 10k–45k rows written per day at ~9,000 boards (limits: 5M and 100k; details in `src/core/config.ts` above `DB_BATCH_SIZE`). A public repo has unlimited Actions minutes.

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

### 4. Set up the poller

1. Push this repo to a **public** GitHub repository (secrets stay hidden; public repos get unlimited Actions minutes, which a 15-minute schedule needs). The workflow re-enables itself each run so GitHub's 60-day inactivity rule doesn't switch it off. For a private repo, change the cron to every 30 minutes to stay within 2,000 free minutes/month.
2. Create a Cloudflare API token at *My Profile → API Tokens → Create Token → Custom token* with only **Account → D1 → Edit**.
3. In the GitHub repo, add these *Settings → Secrets and variables → Actions* secrets:

| Secret | Value |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account id (dashboard sidebar) |
| `CF_D1_DATABASE_ID` | the `database_id` from step 2 |
| `CF_D1_API_TOKEN` | the D1-only API token |
| `TELEGRAM_BOT_TOKEN` | bot token |
| `OWNER_USER_ID` | your user id |

4. So the Worker can start the workflows, create a fine-grained GitHub token (this repo only, *Actions: Read and write*), then `npx wrangler secret put GITHUB_DISPATCH_TOKEN` and set `GITHUB_REPO` in `wrangler.toml`; `npm run deploy`.
5. Run *Actions → Poll job boards → Run workflow* once. The first runs record every currently open job **silently** (400 companies per run); alerts for a company start with jobs posted after its baseline.

## Using the bot

| Command | What it does |
|---|---|
| `/status` | Last check, check hours, companies per tier (fast every 15 min / wide every 90 min), failing fast companies, jobs sent today, and your countries |
| `/add <link>` | Watch a company, e.g. `/add https://jobs.lever.co/acme`. Confirmed within the hour. |
| `/remove <name>` | Stop watching a company (`/remove lever:acme` if the name is ambiguous) |
| `/companies` | List fast-tier companies (⚠️ = failing) and how many wide-tier ones are watched |
| `/exclude add <word>` | Hide jobs mentioning a word or phrase (title or description) |
| `/exclude remove <word>` / `/exclude list` | Manage excluded words |
| `/pause` / `/resume` | Stop/start alerts. Jobs found while paused are never sent later. |
| `/applied` | Your last 20 jobs marked ✅ Applied |
| `/report` | Your daily report for today so far (Brazil time) |
| `/countries` | Choose which countries you get alerts for: tap 🇺🇸 United States, 🇲🇽 Mexico, 🇨🇴 Colombia, 🇦🇷 Argentina to turn each on (✅) or off (⬜). All four are on by default. |
| `/invite <id>` / `/revoke <id>` / `/users` | Give someone the alerts, take them away, list who has them (see below) |

**Daily report:** every day at 09:00 Brazil time (12:00 UTC; Brazil is UTC-3 all year) the owner and every invited user get their own report for the previous Brazil day: jobs applied (with links, up to 25), skipped and alerts received that day, plus applied this week (since Monday 00:00 Brazil time) and all time. It is sent even on a day with no activity. `/report` shows the same for today so far.

Each alert shows the title, company, location, salary (when the board lists it), how long ago it was posted, and the apply link (tap to open, long-press to copy). A ⚠️ under the location means the posting doesn't clearly say US (e.g. just "Remote") or is limited to some states — check before applying.

**Countries.** Alerts cover remote roles open to five countries: 🇺🇸 United States, 🇲🇽 Mexico, 🇨🇴 Colombia, 🇦🇷 Argentina and 🇬🇧 United Kingdom.

- **United States:** as above; a plain "Remote" with no country is treated as possibly-US and flagged ⚠️.
- **Mexico:** "Mexico"/"México", "MX" (as an upper-case token or country code), CDMX / Mexico City, Guadalajara, Monterrey, Querétaro, Puebla, Tijuana, Mérida, León, Jalisco, Nuevo León. "New Mexico" is the US state.
- **Colombia:** "Colombia", country code CO from the board's country field, Bogotá, Medellín, Cali, Barranquilla, Cartagena. A bare "CO" in the location text is **Colorado** ("Denver, CO", "Remote - US (CO)").
- **Argentina:** "Argentina", country code AR from the board's country field, Buenos Aires, CABA, Rosario, Mendoza, and Córdoba (unless another country such as Spain or a US place is named). A bare "AR" is **Arkansas** ("Little Rock, AR", "Remote, AR") unless the location is otherwise outside the US ("Remote - LATAM (BR, AR)", "Buenos Aires, AR").
- **LATAM:** "LATAM", "Latin America", "Latinoamérica" without a named Mexico/Colombia/Argentina counts as open to Mexico, Colombia and Argentina.
- **United Kingdom:** "United Kingdom", "UK" (upper case) / "U.K.", country code GB or UK, "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland", and the cities London, Manchester, Edinburgh, Glasgow, Birmingham, Bristol, Leeds, Cambridge, Oxford, Belfast, Cardiff. A city doesn't count when a US state/place or Canada is named with it: "Birmingham, AL", "Cambridge, MA" are US, "London, ON" is Canada. "New England" is the US region; "New South Wales" is Australia.
- **Europe/EMEA:** "Europe", "European", "EU", "European Union", "EMEA" without the UK named counts as open to the UK (flagged ⚠️ to check UK eligibility). A posting that names the UK ("Remote (UK or EU)", "Europe/UK") is simply a UK posting. Other European countries on their own ("Remote - Germany", "Spain") are skipped.

Matching ignores accents ("Bogota" = "Bogotá"). A Mexico/Colombia/Argentina/UK location without any remote signal is treated as an office job and skipped. When a posting lists several locations, the best one sets the alert type (US, then US-restricted, then Mexico/Colombia/Argentina/UK/LATAM/Europe, then ambiguous), and every remote location adds its country.

**Banners.** US alerts have no banner. Other alerts start with one: **🇲🇽 MEXICO REMOTE**, **🇨🇴 COLOMBIA REMOTE**, **🇦🇷 ARGENTINA REMOTE**, **🇬🇧 UK REMOTE**, combined for several countries (**🇲🇽🇬🇧 MEXICO · UK REMOTE**), **🌎 LATAM REMOTE** plus "⚠️ LATAM — check your country is eligible" for LATAM-wide roles, or **🇪🇺 EUROPE/EMEA REMOTE** plus "⚠️ Europe/EMEA — check UK is eligible" for Europe-wide roles. A US alert that also lists other remote countries adds a line like "Also open to: 🇲🇽 Mexico, 🇬🇧 United Kingdom" (or "🌎 LATAM", "🇪🇺 Europe/EMEA"). The alert text is the same for every recipient.

**Who gets what.** Each person (the owner included) picks their countries with `/countries`; with no choice made, all five are on, and at least one must stay on. An alert goes to everyone whose countries include one the role is open to (LATAM-wide roles go to anyone with Mexico, Colombia or Argentina on; Europe/EMEA-wide roles to anyone with the UK on). A role that matches nobody's countries is marked handled without sending anything (stored as sent, with no message and no delivery rows) and is never sent later, even if someone turns that country on afterwards.

**What counts as a match:** remote, US-eligible (or flagged ambiguous) or Mexico/Colombia/Argentina/UK/LATAM/Europe-remote engineering roles at any level except junior/entry.

- **Roles:** software engineering (backend, frontend, full stack, mobile, product, language-named titles) plus adjacent engineering: DevOps, SRE / Site Reliability, Platform, Infrastructure, Cloud, Systems (only with a software context, e.g. "Software Systems Engineer", "Distributed Systems Engineer"), Data / Analytics Engineer, ML / AI / MLOps / Applied ML Engineer, Security Engineer (application, cloud, product), Developer Productivity, Build / Release Engineer.
- **Levels:** Senior / Sr. / Snr, Staff, Senior Staff, Principal, Distinguished, Lead / Tech Lead, mid-level markers (II, III, IV, 2, 3, L3, Mid) and unleveled titles ("Software Engineer", "Backend Engineer").
- **Excluded:** Junior / Jr., Intern / Internship, Entry-level, Graduate / New Grad / Early Career, Apprentice, Trainee, first-level markers ("Engineer I", "SDE 1", "Level 1", "L1"), Associate as a level; management (manager, director, head of, VP); sales / solutions engineers; support, customer, field, implementation and professional-services engineers; QA / test / SDET; hardware, electrical, mechanical, firmware, embedded, RF and manufacturing; data / business analysts; data and research scientists (unless the title also says engineer, e.g. "ML Engineer"); designers, PMs, recruiters; network engineers without a software context; IT support / help desk.

### Growing the company list

*Expand company list* runs weekly on its own (Mondays 06:00 UTC, started by the Worker) and can be run by hand from *Actions → Expand company list → Run workflow* (inputs: `dry_run`; `target_total`, optional cap on active companies, blank = no cap). Each run:

1. **Demotes** fast companies with no new matching role in 30 days and added more than 30 days ago to the wide tier.
2. **Probes** every board in public lists (remoteintech/remote-jobs and the Feashliaa/job-board-aggregator Greenhouse/Lever/Ashby token lists) not already in the database (removed companies are never re-added) and adds **every live board**: boards with at least one open role passing the rules above start **fast**, other boards that answered start **wide**. Boards that don't exist are skipped; boards that timed out or errored are tried again next week.

It stops probing after 30 minutes and uses what it found. New companies are baselined silently by the poller, 400 per run (~4 hours for 9,000). The first large expansion writes ~50k D1 rows (inserts + baselines) on top of normal use (limit 100k/day); if the D1 dashboard already shows more than ~40k rows written per day, split it over two days with `target_total`. Run with `dry_run` first to see the summary without writing anything.

### Inviting people

The bot is private: only you (`OWNER_USER_ID`) and people you invite can use it, and only in a private chat with the bot.

1. Ask them to open the bot in Telegram and press **Start**. The bot replies once with their numeric user id ("This bot is private. Your Telegram user id is …"), and you get a one-time notice: *Access request from Name (@username) — id 123456789. Tap to allow: /invite 123456789* (tap the command to copy it). Later messages from them are ignored silently, so nobody can spam you.
2. Send `/invite <id>`. They get a welcome message. If you see *"Added, but they need to open the bot and press Start…"*, Telegram refused because they've never started the bot — ask them to press Start; alerts will reach them from then on.
3. `/users` lists everyone invited (name, id, date added). `/revoke <id>` stops their alerts right away; if they write again they're ignored. `/invite` the same id to re-add them.

What invited people get:

- **The same job alerts as you** (for the countries they pick with `/countries`; all five by default), each with its own ✅ Applied / ❌ Skip buttons. Their taps and their `/applied` list are their own and never change yours.
- `/start`, `/help`, `/status`, `/applied`, `/report` and `/countries` (their own country choice), plus their own daily report. Everything else — `/add`, `/remove`, `/companies`, `/exclude`, `/pause`, `/resume`, `/invite`, `/revoke`, `/users` — is owner-only and answers *"Only the owner can do that."*
- Settings are global except countries: `/pause` and excluded words apply to everyone. Watchdog warnings and `/add` confirmations go to you only.

If someone blocks the bot, the poller logs the failed send and carries on with everyone else.

## Troubleshooting

- **"No successful job check for Xh"** — the Worker's hourly watchdog didn't see a successful poller run for 3 hours of active time (it is silent overnight and in the first 90 minutes of the window). Check *Actions → Poll job boards*: workflow disabled, minutes exhausted, or a wrong secret.
- **"N of M fast-checked companies are failing"** — `/status` lists them (wide-tier boards are left out of this warning; many are small and flaky). Boards move or close; `/remove` them or re-add with the new link.
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
npm run expand      # weekly demotion + add every live board (EXPAND_TARGET_TOTAL caps it); --dry-run to preview
```
