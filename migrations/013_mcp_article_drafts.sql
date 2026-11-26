-- One staged revision per article. A published article remains public unchanged
-- until the exact staged revision is explicitly published through MCP.
CREATE TABLE IF NOT EXISTS mcp_article_drafts (
  external_id TEXT PRIMARY KEY,
  article_id BIGINT UNIQUE REFERENCES articles(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  primary_source_key TEXT,
  payload JSONB NOT NULL,
  revision TEXT NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  base_state_hash TEXT NOT NULL CHECK (base_state_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_by TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_article_draft_slug
  ON mcp_article_drafts(slug) WHERE status='draft' AND article_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_article_draft_source
  ON mcp_article_drafts(primary_source_key)
  WHERE status='draft' AND primary_source_key IS NOT NULL AND article_id IS NOT NULL;
