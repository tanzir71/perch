-- Perch v2: channels, engagement, daily rollups.
-- Safe to apply to a v1 database created from 0001 (or the old worker/schema.sql).

ALTER TABLE events ADD COLUMN channel TEXT;
ALTER TABLE events ADD COLUMN scroll_pct INTEGER;
ALTER TABLE events ADD COLUMN engaged_ms INTEGER;

-- Every query is project + time range, so one index is enough. Each extra index
-- costs one more written row per event on D1.
DROP INDEX IF EXISTS idx_events_project_visitor;
DROP INDEX IF EXISTS idx_events_project_type_ts;

-- One row per project, UTC day, dimension and key. Filled nightly by the Cron Trigger.
CREATE TABLE IF NOT EXISTS daily (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  dim        TEXT NOT NULL,
  key        TEXT NOT NULL,
  events     INTEGER NOT NULL DEFAULT 0,
  visitors   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, dim, key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day, project_id);

-- The last UTC day whose events are fully summarised in `daily`.
CREATE TABLE IF NOT EXISTS rollup_state (
  project_id   TEXT PRIMARY KEY,
  rolled_until TEXT NOT NULL
);
