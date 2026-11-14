-- A Google identity is linked by its stable subject, never by an email match alone.
-- Rollback: DROP INDEX IF EXISTS ix_users_google_sub; ALTER TABLE users DROP COLUMN google_sub;
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_sub ON users (google_sub);
