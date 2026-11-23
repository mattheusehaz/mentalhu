-- Persist one-time owner-authorized hero assignments; survives article deletion.
CREATE TABLE IF NOT EXISTS article_hero_assignment_ledger (
  external_id TEXT PRIMARY KEY,
  article_revision TEXT NOT NULL,
  image_path TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
