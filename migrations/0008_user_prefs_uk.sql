-- Adds the United Kingdom (UK) to /countries. Users with no user_prefs row already get every
-- country, UK included. Everyone who changed their selection gets UK turned on too (owner's
-- choice). user_prefs has one row per user who ran /countries (a handful of rows), and
-- user_prefs.countries is read order-insensitively, so appending is enough. Re-running is a no-op.
UPDATE user_prefs SET countries = countries || ',UK' WHERE ',' || countries || ',' NOT LIKE '%,UK,%';
