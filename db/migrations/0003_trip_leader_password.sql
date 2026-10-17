ALTER TABLE trips ADD COLUMN leader_password_salt TEXT;
ALTER TABLE trips ADD COLUMN leader_password_hash TEXT;
ALTER TABLE trip_members ADD COLUMN member_token TEXT;
