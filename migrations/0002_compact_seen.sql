-- Board job ids that were seen but never matched (baseline, or failed role/seniority/location),
-- stored compactly per company as a JSON array instead of one `jobs` row each, to keep D1 rows
-- written low. The poller prunes ids that leave the board. Legacy 'seen' rows in `jobs` stay
-- and are still treated as known.
ALTER TABLE companies ADD COLUMN seen_ids TEXT NOT NULL DEFAULT '[]';
