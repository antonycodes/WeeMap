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

INSERT OR IGNORE INTO trip_slots (trip_id, slot_code, member_id, claimed_at)
SELECT member.trip_id,
  'XE-' || printf('%02d', (
    SELECT COUNT(*)
    FROM trip_members AS previous
    WHERE previous.trip_id = member.trip_id
      AND (previous.joined_at < member.joined_at
        OR (previous.joined_at = member.joined_at AND previous.member_id <= member.member_id))
  )),
  member.member_id,
  member.joined_at
FROM trip_members AS member;
