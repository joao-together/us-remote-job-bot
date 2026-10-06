---
date: 2026-10-06
topic: us-remote-job-telegram-bot
---

# US Remote Job Telegram Bot

## Summary

A free, private Telegram bot that checks the public job boards of a few hundred remote-friendly US tech companies every hour and sends one message per new senior software engineering role that is remote in the US. Each message carries a direct apply link plus Applied / Skip buttons, and the bot is controlled entirely from Telegram.

---

## Problem Frame

The user wants to find senior remote software roles open to US candidates as soon as they appear, without paying for a job-board subscription. Remote Rocketship ($18/month or about $5–6/week) is the board they had in mind. It builds its listings by scraping around 30k company applicant-tracking-system (ATS) pages, and offers no free tier, public RSS feed or API. Getting its listings without paying would mean scraping gated pages, which breaks its terms and risks being blocked. The same jobs already exist at the source: Greenhouse, Lever, Ashby and similar ATS platforms publish public job feeds meant for redistribution. Reading those feeds directly costs nothing and is legitimate.

---

## Key Decisions

- **Read company ATS feeds directly, not Remote Rocketship.** It's free and allowed, and the bot sees postings as soon as the company publishes them. The trade-off is coverage: the bot only sees companies on its watch list.
- **Hourly check cycle.** The user said hourly is fine. That keeps hosting free, avoids rate limits on a few hundred company boards, and still delivers alerts well within the window where applying early matters. The original 2-minute idea was dropped because nothing about the job search needs it.
- **Ambiguous locations are sent with a flag, not dropped.** This trades a little noise for fewer missed roles.
- **The first run is silent.** Jobs already open when the bot first runs are recorded as seen and never sent, so setup doesn't flood the chat.
- **The bot has one user.** It responds only to the owner's Telegram account.

---

## Requirements

**Job sources**
- R1. The bot watches a seeded list of a few hundred known remote-friendly US tech companies whose job boards use public ATS feeds (e.g., Greenhouse, Lever, Ashby, Workable).
- R2. The user can add a company from Telegram, by company name and/or careers-page link, and remove a company from the watch list. The bot confirms each change and reports when it can't read a company's board.
- R3. The bot checks every watched company about once an hour.

**Matching**
- R4. Only roles that are remote count. On-site and hybrid roles are dropped.
- R5. Location handling:
  - Roles explicitly open to the US (e.g., "Remote – US", "United States", "USA", "US or Canada") are sent.
  - Roles that just say "Remote" with no country, or are limited to certain US states, are sent with a ⚠️ note naming the ambiguity.
  - Roles clearly limited to other regions (EU, UK, LATAM, APAC, etc.) are dropped.
- R6. Only software engineering roles count: backend, frontend, full-stack, mobile and general software engineer titles. No stack filter.
- R7. Only senior-level titles count: Senior, Sr., and Lead. Staff, Principal, mid-level, junior and intern titles are excluded.
- R8. The user can manage a list of words that hide a job (`/exclude`) from Telegram: add, remove and list them. A job whose title or description contains an excluded word is not sent.
- R9. Each job is sent at most once, even if the company edits or reposts the same listing.

**Alerts**
- R10. Each new matching job arrives as its own Telegram message containing: job title, company, location (with the ⚠️ note when applicable), salary if listed, how long ago it was posted when known, and the direct apply link.
- R11. The apply link points to the company's own application page, not an aggregator. It can be tapped to open and long-pressed to copy.
- R12. Each job message has ✅ Applied and ❌ Skip buttons. Tapping one records the choice and visibly updates the message.
- R13. `/applied` lists the jobs marked Applied, with company, title, link and the date marked.

**Control and health**
- R14. `/status` shows when the last check ran, how many companies are watched, and how many jobs were sent today.
- R15. `/pause` stops alerts and `/resume` restarts them. Jobs posted while paused are still recorded, so resuming doesn't send a backlog older than the pause.
- R16. If checks stop running or keep failing (for example, no successful check for several hours), the bot sends a warning message.
- R17. The bot runs at zero recurring cost.

---

## Acceptance Examples

- AE1. **Covers R5.** Given a posting with location "Remote", when it matches title and seniority, it is sent with a ⚠️ note that the location doesn't say US.
- AE2. **Covers R5.** Given a posting with location "Remote – EMEA", it is not sent.
- AE3. **Covers R7.** Given "Staff Software Engineer, Remote US", it is not sent. Given "Sr. Frontend Engineer, Remote US", it is sent.
- AE4. **Covers R8.** Given the excluded word "clearance", a senior backend role whose description requires a security clearance is not sent.
- AE5. **Covers R15.** Given the bot is paused for two days, when the user resumes it, the jobs posted during those two days are not sent. Only jobs posted after resuming are sent.
- AE6. **Covers R9.** Given a job already sent yesterday, when the company edits its description today, it is not sent again.

---

## Scope Boundaries

- Remote Rocketship as a data source, whether through scraping or paid access.
- Companies hiring through Workday or a custom careers site that has no public feed. Deferred: these could be added later if coverage proves thin.
- A salary floor filter. Deferred: it was offered and not chosen for v1.
- Scoring how well a job fits, ranking by fit, or résumé matching.
- Auto-apply or filling in applications. The user applies themselves through the link.
- More than one user, or sharing the bot with others.
- Checking faster than hourly. It's easy to tighten to about 10 minutes later if needed.

---

## Dependencies / Assumptions

- Enough remote-friendly companies use public-feed ATS platforms for a few hundred companies to produce useful daily volume. Unverified; check this when building the seed list.
- A free hosting option can run an hourly check and the Telegram bot reliably. The specific host is chosen during planning.
- Job descriptions contain enough location wording to classify US-remote vs non-US with a simple rule set. Expect some misclassification, which the ⚠️ flag absorbs.

---

## Outstanding Questions

### Deferred to Planning

- Which ATS platforms to support first, and where the seed company list comes from.
- Which free hosting option to use, and how the bot stores what it has already seen and the user's Applied/Skip choices.
- The exact rules for spotting a remote role and its location, given that each ATS reports location differently.
- How long without a successful check before R16 sends its warning.

---

## Sources

- [startup.jobs: Remote Rocketship](https://startup.jobs/job-boards/remote-rocketship): pricing and how it gathers listings by scraping ATS pages.
- [Kardow: job board examples](https://kardow.com/articles/job-board-examples): pricing confirmation.
