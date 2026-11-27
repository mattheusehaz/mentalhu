-- Provider CRM data never shares the public directory or newsletter tables.
-- Personal fields, notes, event bodies and per-account search keys are encrypted.
CREATE TABLE IF NOT EXISTS provider_crm_settings (
 account_id BIGINT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
 search_key_ciphertext TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_crm_contacts (
 id UUID PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 source_type TEXT NOT NULL CHECK(source_type IN ('manual','inquiry')),
 -- Keep this opaque source identifier even after an erasure: it prevents
 -- an automatically mirrored inquiry from being imported again.
 source_inquiry_id UUID,
 source_listing_id BIGINT REFERENCES directory_listings(id) ON DELETE SET NULL,
 source_created_at TIMESTAMPTZ,
 payload_ciphertext TEXT,
 search_tokens TEXT[] NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','appointment','active','closed','lost')),
 next_followup_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 deleted_at TIMESTAMPTZ,
 deleted_reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,account_id),
 CHECK((source_type='manual' AND source_inquiry_id IS NULL) OR (source_type='inquiry' AND source_inquiry_id IS NOT NULL)),
 CHECK(source_type<>'inquiry' OR expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_crm_inquiry ON provider_crm_contacts(source_inquiry_id) WHERE source_inquiry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_crm_account ON provider_crm_contacts(account_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_provider_crm_followups ON provider_crm_contacts(account_id,next_followup_at,id) WHERE deleted_at IS NULL AND next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_crm_search ON provider_crm_contacts USING GIN(search_tokens) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS provider_crm_events (
 id UUID PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 contact_id UUID NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('created','inquiry_received','updated','note','call','email','meeting','followup_completed')),
 payload_ciphertext TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(contact_id,account_id) REFERENCES provider_crm_contacts(id,account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_provider_crm_events ON provider_crm_events(account_id,contact_id,occurred_at DESC,id);
