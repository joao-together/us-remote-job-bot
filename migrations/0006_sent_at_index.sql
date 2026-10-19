-- "Jobs sent today" (/status) counted every sent job ever through jobs_status; this partial
-- index lets it read only the jobs sent since midnight (queried with INDEXED BY jobs_sent_at).
-- Costs one extra index row written per sent job.
CREATE INDEX jobs_sent_at ON jobs (sent_at) WHERE status = 'sent';
