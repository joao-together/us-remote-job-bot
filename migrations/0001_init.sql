-- Companies whose public job boards are watched.
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ats TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby', 'workable')),
  board_token TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_validation'
    CHECK (state IN ('active', 'pending_validation', 'inactive')),
  baselined INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (ats, board_token)
);

-- Every job id ever seen on a watched board, plus delivery and user state.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  board_job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  location_text TEXT NOT NULL DEFAULT '',
  location_class TEXT,
  location_reason TEXT,
  apply_url TEXT NOT NULL,
  posted_at INTEGER,
  salary_text TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('seen', 'duplicate', 'excluded', 'suppressed', 'pending', 'sending', 'sent')),
  telegram_message_id INTEGER,
  user_action TEXT CHECK (user_action IN ('applied', 'skipped')),
  action_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (company_id, board_job_id)
);

CREATE INDEX jobs_repost_lookup ON jobs (company_id, normalized_title, location_text);
CREATE INDEX jobs_status ON jobs (status, first_seen_at);

-- Small key/value store: paused, excluded words, poll stats, watchdog state.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
