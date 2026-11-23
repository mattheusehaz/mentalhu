-- Preserve the original CMS and add provenance for editorial imports.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS hero_image_path TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS hero_image_caption TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_revision TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS publication_origin TEXT NOT NULL DEFAULT 'cms';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS approval_ref TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS primary_source_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_external_id ON articles(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_primary_source_key ON articles(primary_source_key) WHERE primary_source_key IS NOT NULL;

-- This ledger intentionally survives article deletion. A restart must not undo
-- an editor's decision to delete, unpublish or edit an imported article.
CREATE TABLE IF NOT EXISTS article_import_ledger (
  import_key TEXT PRIMARY KEY,
  import_kind TEXT NOT NULL CHECK (import_kind IN ('legacy','approved')),
  source_path TEXT NOT NULL,
  revision TEXT NOT NULL,
  article_id BIGINT REFERENCES articles(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('imported','preserved_existing')),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
