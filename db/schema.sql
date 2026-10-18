CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  leader_google_sub TEXT,
  leader_password_salt TEXT,
  leader_password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  member_token TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, member_id)
);

CREATE TABLE IF NOT EXISTS trip_slots (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  slot_code TEXT NOT NULL,
  member_id TEXT,
  claimed_at TEXT,
  PRIMARY KEY (trip_id, slot_code),
  UNIQUE (trip_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_slots_trip
  ON trip_slots(trip_id);

CREATE TABLE IF NOT EXISTS location_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  accuracy REAL,
  speed_kmh REAL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_location_events_trip_time
  ON location_events(trip_id, recorded_at DESC);
