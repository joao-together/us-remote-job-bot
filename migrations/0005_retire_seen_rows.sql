-- Cut D1 row reads: the poller's known-id and repost queries read every `jobs` row of each
-- polled company, including thousands of legacy 'seen' rows stored before non-matching ids moved
-- to companies.seen_ids (0002). Fold those ids into seen_ids (so they stay "known" and are never
-- re-alerted), delete the rows, and index the repost lookup so it reads only recent
-- sent/pending/sending rows.

UPDATE companies SET seen_ids = (
  SELECT json_group_array(id) FROM (
    SELECT CAST(value AS TEXT) AS id FROM json_each(companies.seen_ids)
    UNION
    SELECT board_job_id AS id FROM jobs WHERE jobs.company_id = companies.id AND jobs.status = 'seen'
  )
)
WHERE EXISTS (SELECT 1 FROM jobs WHERE jobs.company_id = companies.id AND jobs.status = 'seen');

DELETE FROM jobs WHERE status = 'seen'
  AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.job_id = jobs.id);

-- Matches the repost query's filter exactly so SQLite can use this partial index.
CREATE INDEX jobs_repost_recent ON jobs (company_id, first_seen_at)
  WHERE status IN ('sent', 'pending', 'sending');
