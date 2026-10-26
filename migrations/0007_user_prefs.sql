-- Per-user country selection (/countries): which remote roles a recipient gets alerts for, among
-- US, MX (Mexico), CO (Colombia) and AR (Argentina), stored as comma-separated codes ("US,CO").
-- One row per user who changed it; no row means all four. The owner (OWNER_USER_ID, not in
-- `users`) gets a row here too. New table only: no existing rows are read or rewritten.
CREATE TABLE user_prefs (
  user_id TEXT PRIMARY KEY,
  countries TEXT NOT NULL
);
