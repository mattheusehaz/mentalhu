-- Contact data is separate from the public directory and newsletter subscribers.
CREATE TABLE IF NOT EXISTS directory_contact_settings (
 id SMALLINT PRIMARY KEY CHECK(id=1),
 settings_ciphertext TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS directory_contact_inquiries (
 id UUID PRIMARY KEY,
 request_key UUID NOT NULL UNIQUE,
 listing_id BIGINT REFERENCES directory_listings(id) ON DELETE SET NULL,
 payload_ciphertext TEXT,
 requester_hash TEXT,
 ip_hash TEXT,
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('needs_mail','needs_recipient','queued','sending','accepted','failed','uncertain','cancelled','expired')),
 processing_status TEXT NOT NULL DEFAULT 'new' CHECK(processing_status IN ('new','in_progress','closed')),
 consent_version TEXT NOT NULL,
 consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 sending_since TIMESTAMPTZ,
 accepted_at TIMESTAMPTZ,
 provider_message_id TEXT,
 error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_queue ON directory_contact_inquiries(delivery_status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_contact_expiration ON directory_contact_inquiries(expires_at);
CREATE INDEX IF NOT EXISTS idx_contact_created ON directory_contact_inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_rate_email ON directory_contact_inquiries(requester_hash,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_rate_ip ON directory_contact_inquiries(ip_hash,created_at DESC);
CREATE TABLE IF NOT EXISTS directory_contact_events (
 id BIGSERIAL PRIMARY KEY,
 inquiry_id UUID NOT NULL REFERENCES directory_contact_inquiries(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL,
 actor TEXT NOT NULL DEFAULT 'system',
 details JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_events ON directory_contact_events(inquiry_id,created_at,id);
ALTER TABLE directory_listings ADD COLUMN IF NOT EXISTS email_source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE directory_listings ADD COLUMN IF NOT EXISTS contact_disabled BOOLEAN NOT NULL DEFAULT false;
