-- A rating belongs to the authenticated reader, never to a supplied author ID.
CREATE TABLE IF NOT EXISTS provider_ratings (
  account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL REFERENCES directory_listings(id) ON DELETE CASCADE,
  score SMALLINT NOT NULL CHECK(score BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,listing_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_ratings_listing ON provider_ratings(listing_id,score);
