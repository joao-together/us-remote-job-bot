# Seed companies

- `companies.json`: probe-validated boards (`name`, `ats`, `token`, job counts at build time), capped at ~350 by US-eligible software jobs.
- `companies.sql`: idempotent inserts (`ON CONFLICT(ats, board_token) DO NOTHING`). Companies start `active` with `baselined = 0`, so the poller's first run records their current jobs silently.
- Sources: [remoteintech/remote-jobs](https://github.com/remoteintech/remote-jobs) company profiles (ISC License), board-token lists from [Feashliaa/job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) (MIT License, used only to resolve careers pages that hide their board), and the hand-curated `scripts/seed-extra.json`.
- Regenerate: `npm run seed:build` (network required; set `GITHUB_TOKEN` if the GitHub API rate-limits you).
- Apply: `npx wrangler d1 execute jobbot --remote --file seed/companies.sql`
