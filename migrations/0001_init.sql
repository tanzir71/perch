CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  origin     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT,
  path          TEXT,
  referrer_host TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  country       TEXT,
  device        TEXT,
  browser       TEXT,
  os            TEXT,
  visitor_hash  TEXT NOT NULL,
  screen_bucket TEXT,
  lang          TEXT,
  props         TEXT,
  ts            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project_ts
  ON events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_project_visitor
  ON events(project_id, visitor_hash, ts);
CREATE INDEX IF NOT EXISTS idx_events_project_type_ts
  ON events(project_id, type, ts);
