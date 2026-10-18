-- The integration monitor counts messages per window; the window is on the receipt time.
CREATE INDEX ingest_messages_received ON ingest_messages (received_at);
