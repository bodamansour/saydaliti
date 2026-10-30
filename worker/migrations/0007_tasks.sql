-- The owner's to-do list (table «tasks» in src/schema.js, marked { added: 7 }).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  assignee TEXT,
  due_on TEXT,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  ref TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_tasks_pharmacy_id_status ON tasks (pharmacy_id, status);
