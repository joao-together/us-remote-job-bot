-- Polling tiers. 'fast' boards are checked every run (every 10 minutes); 'wide' boards are split
-- into WIDE_SLOTS (6) groups by id % 6 and each group is checked once an hour. A wide board that
-- yields a new matching job is promoted to fast; the weekly expansion run demotes fast boards
-- without a match in 30 days (see scripts/expand-lib.ts selectDemotions).
ALTER TABLE companies ADD COLUMN tier TEXT NOT NULL DEFAULT 'fast' CHECK (tier IN ('fast', 'wide'));

-- Epoch ms of the last new job on this board that passed the match rules (after baseline).
ALTER TABLE companies ADD COLUMN last_match_at INTEGER;

-- Serves every part of the poller's selection (Store.listCompaniesForRun) so D1 reads only the
-- rows a run polls: (state, tier, baselined) for fast and not-yet-baselined boards, plus the wide
-- slot expression. The expression must match the query text exactly: `id % 6` with 6 =
-- WIDE_SLOTS in src/core/config.ts. Changing WIDE_SLOTS needs a new index (results stay correct
-- without one, but each run would read every wide row).
CREATE INDEX companies_tier_slot ON companies (state, tier, baselined, (id % 6));

-- Existing boards keep tier 'fast'. Seed last_match_at from stored matches (any job row that went
-- through matching), so the first weekly demotion is based on real history.
UPDATE companies SET last_match_at = (
  SELECT MAX(first_seen_at) FROM jobs WHERE jobs.company_id = companies.id AND jobs.status <> 'seen'
)
WHERE EXISTS (SELECT 1 FROM jobs WHERE jobs.company_id = companies.id AND jobs.status <> 'seen');
