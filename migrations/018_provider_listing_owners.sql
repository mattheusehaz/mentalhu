-- Ownership is explicit. Matching a public listing's email never grants access.
CREATE TABLE IF NOT EXISTS provider_listing_owners (
 account_id BIGINT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
 listing_id BIGINT NOT NULL UNIQUE REFERENCES directory_listings(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
