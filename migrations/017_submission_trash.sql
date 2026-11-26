-- Submission trash is reversible. No background purge or hard delete is installed.
ALTER TABLE directory_submissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE directory_submissions ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE directory_submissions ADD COLUMN IF NOT EXISTS provider_account_id BIGINT REFERENCES provider_accounts(id) ON DELETE SET NULL;
ALTER TABLE directory_submissions ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_directory_submissions_active_created ON directory_submissions(created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_directory_submissions_trash_created ON directory_submissions(deleted_at DESC,id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_directory_submissions_provider_account ON directory_submissions(provider_account_id) WHERE provider_account_id IS NOT NULL;
