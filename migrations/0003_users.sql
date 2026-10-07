-- Private whitelist: the owner (OWNER_USER_ID, never stored here) can invite other Telegram users
-- who then receive the same job alerts, each with their own Applied/Skip state.

-- Invited users. Revoking sets active = 0 (the row is kept so a re-invite reactivates it).
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL
);

-- First contact from a non-whitelisted user. One row per user, so only the first message gets a
-- reply and an owner notice; later messages are silently ignored. Never deleted by /revoke.
CREATE TABLE access_requests (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  requested_at INTEGER NOT NULL
);

-- One row per (job, recipient) message actually sent, plus that recipient's own Applied/Skip.
-- Supersedes jobs.telegram_message_id / jobs.user_action / jobs.action_at (kept for legacy rows).
CREATE TABLE deliveries (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  user_id TEXT NOT NULL,
  telegram_message_id INTEGER,
  sent_at INTEGER NOT NULL,
  user_action TEXT CHECK (user_action IN ('applied', 'skipped')),
  action_at INTEGER,
  PRIMARY KEY (job_id, user_id)
);

CREATE INDEX deliveries_applied ON deliveries (user_id, action_at) WHERE user_action = 'applied';
