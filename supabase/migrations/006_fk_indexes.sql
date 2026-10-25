create index on invites (used_by);
create index on snapshots (created_by);
-- Only the daily job (anon + secret) reads the report feed.
revoke execute on function report_feed(text) from authenticated;
