CREATE INDEX IF NOT EXISTS proposal_projection_status
  ON proposal_projection(status);
CREATE INDEX IF NOT EXISTS assertion_projection_privacy
  ON assertion_projection(privacy, status, valid_from_ms);
CREATE INDEX IF NOT EXISTS decision_projection_privacy
  ON decision_projection(privacy, decided_at_ms);

UPDATE schema_metadata SET schema_version = 2 WHERE singleton = 1;
