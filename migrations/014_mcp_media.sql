-- MCP uploads are immutable and private until a published article references them.
-- Existing CMS media keeps its previous public behavior.
ALTER TABLE media ADD COLUMN IF NOT EXISTS mcp_managed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media ADD COLUMN IF NOT EXISTS sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_mcp_sha256
  ON media(sha256) WHERE mcp_managed AND sha256 IS NOT NULL;

