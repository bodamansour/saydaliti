-- Plans: what each plan includes (app_config.plans) and each pharmacy's plan (subscriptions.plan).
-- (Columns marked { added: 8 } in src/schema.js.) No plan = everything, as before.
ALTER TABLE app_config ADD COLUMN plans TEXT;
ALTER TABLE subscriptions ADD COLUMN plan TEXT;
