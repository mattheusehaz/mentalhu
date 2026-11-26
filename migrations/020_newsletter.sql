-- Keep previous consent evidence and links. Legacy readers are not silently
-- assigned interests or treated as mailbox-confirmed subscribers.
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS consent_version TEXT NOT NULL DEFAULT '';
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS preferences_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS merged_into_id BIGINT REFERENCES newsletter_subscribers(id);
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS legacy_status TEXT;
ALTER TABLE newsletter_subscribers DROP CONSTRAINT IF EXISTS newsletter_subscribers_status_check;
ALTER TABLE newsletter_subscribers ADD CONSTRAINT newsletter_subscribers_status_check CHECK (status IN ('pending','active','unsubscribed'));

-- Case variants retain their original rows and unsubscribe links. Any previous
-- opt-out wins when choosing the canonical record; nothing is deleted.
UPDATE newsletter_subscribers SET legacy_status=status WHERE legacy_status IS NULL AND confirmed_at IS NULL AND status IN ('active','unsubscribed');
WITH grouped AS (
  SELECT lower(btrim(email)) AS address,min(id) AS canonical_id,bool_or(status='unsubscribed') AS opted_out
  FROM newsletter_subscribers GROUP BY lower(btrim(email)) HAVING count(*)>1
)
UPDATE newsletter_subscribers s SET status='unsubscribed'
FROM grouped g WHERE s.id=g.canonical_id AND g.opted_out AND s.confirmed_at IS NULL;
WITH grouped AS (
  SELECT lower(btrim(email)) AS address,min(id) AS canonical_id
  FROM newsletter_subscribers GROUP BY lower(btrim(email)) HAVING count(*)>1
)
UPDATE newsletter_subscribers s SET merged_into_id=g.canonical_id
FROM grouped g WHERE lower(btrim(s.email))=g.address AND s.id<>g.canonical_id AND s.merged_into_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_email_canonical ON newsletter_subscribers(lower(btrim(email))) WHERE merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_newsletter_eligible ON newsletter_subscribers(id) WHERE merged_into_id IS NULL AND status='active' AND confirmed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS newsletter_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  first_due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The first eligible edition is the next future Friday, never a historical send
-- immediately after deploying. Local calendar arithmetic follows Budapest DST.
WITH local_time AS (SELECT now() AT TIME ZONE 'Europe/Budapest' AS value),
slot AS (SELECT value,date_trunc('week',value)+interval '4 days 8 hours' AS friday FROM local_time)
INSERT INTO newsletter_settings(id,first_due_at)
SELECT 1,(CASE WHEN friday>value THEN friday ELSE friday+interval '7 days' END) AT TIME ZONE 'Europe/Budapest' FROM slot
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS newsletter_tokens (
  id UUID PRIMARY KEY,
  subscriber_id BIGINT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('confirm','preferences','unsubscribe')),
  token_hash TEXT NOT NULL UNIQUE,
  payload_ciphertext TEXT,
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(kind='unsubscribe' OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_tokens_subscriber ON newsletter_tokens(subscriber_id,kind);

CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id UUID PRIMARY KEY,
  scheduled_at TIMESTAMPTZ NOT NULL UNIQUE,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','completed','completed_with_errors','empty')),
  recipient_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  uncertain_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(window_start<window_end)
);

CREATE TABLE IF NOT EXISTS newsletter_mail_jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','digest','test')),
  subscriber_id BIGINT REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
  token_id UUID REFERENCES newsletter_tokens(id) ON DELETE SET NULL,
  payload_ciphertext TEXT,
  preferences_version INTEGER,
  article_ids BIGINT[] NOT NULL DEFAULT '{}',
  article_count INTEGER NOT NULL DEFAULT 0,
  delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK(delivery_status IN ('queued','needs_mail','sending','accepted','failed','uncertain','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sending_since TIMESTAMPTZ,
  provider_message_id TEXT,
  error_code TEXT,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id,subscriber_id),
  CHECK(kind<>'digest' OR (campaign_id IS NOT NULL AND subscriber_id IS NOT NULL)),
  CHECK(kind<>'confirmation' OR subscriber_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_jobs_pending ON newsletter_mail_jobs(next_attempt_at,created_at) WHERE delivery_status IN ('queued','needs_mail');
CREATE INDEX IF NOT EXISTS idx_newsletter_jobs_subscriber ON newsletter_mail_jobs(subscriber_id,created_at DESC);

CREATE TABLE IF NOT EXISTS newsletter_request_limits (
  scope_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 1,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
