CREATE TABLE IF NOT EXISTS provider_accounts (
 id BIGSERIAL PRIMARY KEY,
 email TEXT NOT NULL UNIQUE CHECK (email=lower(btrim(email))),
 display_name TEXT NOT NULL DEFAULT '',
 password_hash TEXT,
 email_verified_at TIMESTAMPTZ,
 approved_at TIMESTAMPTZ,
 disabled_at TIMESTAMPTZ,
 consent_at TIMESTAMPTZ,
 consent_version TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_account_sessions (
 session_hash CHAR(64) PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_account ON provider_account_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_expiry ON provider_account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS provider_account_tokens (
 id UUID PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 submission_id BIGINT REFERENCES directory_submissions(id) ON DELETE SET NULL,
 kind TEXT NOT NULL CHECK(kind IN ('setup','invite','reset')),
 token_hash CHAR(64) NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_provider_tokens_account ON provider_account_tokens(account_id,kind);
CREATE INDEX IF NOT EXISTS idx_provider_tokens_expiry ON provider_account_tokens(expires_at);

CREATE TABLE IF NOT EXISTS provider_account_mail (
 id UUID PRIMARY KEY,
 dedupe_key TEXT NOT NULL UNIQUE,
 account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 submission_id BIGINT REFERENCES directory_submissions(id) ON DELETE SET NULL,
 token_id UUID REFERENCES provider_account_tokens(id) ON DELETE SET NULL,
 kind TEXT NOT NULL CHECK(kind IN ('setup','invite','approved','reset','password_changed')),
 payload_ciphertext TEXT,
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('needs_mail','queued','sending','accepted','failed','uncertain','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 sending_since TIMESTAMPTZ,
 accepted_at TIMESTAMPTZ,
 provider_message_id TEXT,
 error_code TEXT,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_mail_queue ON provider_account_mail(delivery_status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_provider_mail_submission ON provider_account_mail(submission_id,created_at DESC);

CREATE TABLE IF NOT EXISTS provider_account_events (
 id BIGSERIAL PRIMARY KEY,
 account_id BIGINT REFERENCES provider_accounts(id) ON DELETE SET NULL,
 submission_id BIGINT REFERENCES directory_submissions(id) ON DELETE SET NULL,
 event_type TEXT NOT NULL,
 actor TEXT NOT NULL DEFAULT 'system',
 details JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_events_account ON provider_account_events(account_id,created_at DESC);

-- Hashes throttle requests without retaining a separate email-address/IP log.
CREATE TABLE IF NOT EXISTS provider_account_limits (
 scope_key CHAR(64) PRIMARY KEY,
 window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 request_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS provider_login_attempts (
 email_hash CHAR(64) PRIMARY KEY,
 window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 failures INTEGER NOT NULL DEFAULT 0,
 locked_until TIMESTAMPTZ
);

-- Suspension or a password replacement revokes sessions even if performed by an admin SQL path.
CREATE OR REPLACE FUNCTION revoke_provider_account_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL) OR NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
  DELETE FROM provider_account_sessions WHERE account_id=NEW.id;
 END IF;
 IF NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL THEN
  UPDATE provider_account_tokens SET cancelled_at=now() WHERE account_id=NEW.id AND consumed_at IS NULL AND cancelled_at IS NULL;
  UPDATE provider_account_mail SET delivery_status='cancelled',payload_ciphertext=NULL,error_code='ACCOUNT_DISABLED',updated_at=now()
   WHERE account_id=NEW.id AND delivery_status IN ('needs_mail','queued','failed','uncertain');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS provider_account_access_changed ON provider_accounts;
CREATE TRIGGER provider_account_access_changed AFTER UPDATE OF password_hash,disabled_at ON provider_accounts
 FOR EACH ROW EXECUTE FUNCTION revoke_provider_account_access();
