-- Existing accounts were created through the provider-only flow. Preserve their
-- profiles and invitations, while every account registered after this migration
-- starts as a reader. Re-running this migration never upgrades new readers.
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
   AND table_name='provider_accounts' AND column_name='provider_profile_started_at') THEN
  ALTER TABLE provider_accounts ADD COLUMN provider_profile_started_at TIMESTAMPTZ;
  UPDATE provider_accounts SET provider_profile_started_at=created_at;
 END IF;
END $$;

-- A narrow, server-validated return path survives confirmation/reset emails.
-- The existing opaque token/session storage and expiry remain unchanged.
ALTER TABLE provider_account_tokens ADD COLUMN IF NOT EXISTS next_path TEXT NOT NULL DEFAULT '/fiokom'
 CHECK(length(next_path)<=500);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_profile_started ON provider_accounts(id)
 WHERE provider_profile_started_at IS NOT NULL;
