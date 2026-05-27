ALTER TABLE messages ADD COLUMN telemetry_id TEXT;
CREATE INDEX idx_messages_telemetry ON messages(telemetry_id);
