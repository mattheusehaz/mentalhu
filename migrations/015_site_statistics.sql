-- Anonymous aggregates are separate from contact payloads and editorial content.
CREATE TABLE IF NOT EXISTS site_statistics_settings (
 id SMALLINT PRIMARY KEY CHECK (id=1),
 measurement_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 contacts_started_at TIMESTAMPTZ,
 contacts_backfilled_at TIMESTAMPTZ
);
INSERT INTO site_statistics_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS site_statistics_days (
 day DATE PRIMARY KEY,
 visitors BIGINT NOT NULL DEFAULT 0 CHECK(visitors>=0),
 views BIGINT NOT NULL DEFAULT 0 CHECK(views>=0),
 article_views BIGINT NOT NULL DEFAULT 0 CHECK(article_views>=0),
 listing_views BIGINT NOT NULL DEFAULT 0 CHECK(listing_views>=0),
 contacts BIGINT NOT NULL DEFAULT 0 CHECK(contacts>=0)
);
CREATE TABLE IF NOT EXISTS site_statistics_weeks (
 week_start DATE PRIMARY KEY,
 visitors BIGINT NOT NULL DEFAULT 0 CHECK(visitors>=0)
);
CREATE TABLE IF NOT EXISTS site_statistics_pages (
 day DATE NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('article','listing')),
 entity_id BIGINT NOT NULL,
 views BIGINT NOT NULL DEFAULT 0 CHECK(views>=0),
 contacts BIGINT NOT NULL DEFAULT 0 CHECK(contacts>=0),
 PRIMARY KEY(day,kind,entity_id)
);
CREATE INDEX IF NOT EXISTS idx_site_statistics_entity ON site_statistics_pages(kind,entity_id,day);
-- These temporary keys cannot be joined to pages; raw network/browser data is never saved.
CREATE TABLE IF NOT EXISTS site_statistics_visitors (
 scope TEXT NOT NULL CHECK(scope IN ('day','week')),
 bucket DATE NOT NULL,
 visitor_key CHAR(64) NOT NULL,
 PRIMARY KEY(scope,bucket,visitor_key)
);
CREATE TABLE IF NOT EXISTS site_statistics_receipts (
 nonce CHAR(32) PRIMARY KEY,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_statistics_receipt_expiry ON site_statistics_receipts(expires_at);

-- Hold off contact inserts while the one-time backfill and trigger are installed.
-- The application runs each migration inside its own transaction.
LOCK TABLE directory_contact_inquiries IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
 IF (SELECT contacts_backfilled_at IS NULL FROM site_statistics_settings WHERE id=1) THEN
  INSERT INTO site_statistics_days(day,contacts)
   SELECT (created_at AT TIME ZONE 'Europe/Budapest')::date,count(*)
   FROM directory_contact_inquiries GROUP BY 1
   ON CONFLICT(day) DO UPDATE SET contacts=site_statistics_days.contacts+EXCLUDED.contacts;
  INSERT INTO site_statistics_pages(day,kind,entity_id,contacts)
   SELECT (created_at AT TIME ZONE 'Europe/Budapest')::date,'listing',listing_id,count(*)
   FROM directory_contact_inquiries WHERE listing_id IS NOT NULL GROUP BY 1,3
   ON CONFLICT(day,kind,entity_id) DO UPDATE SET contacts=site_statistics_pages.contacts+EXCLUDED.contacts;
  UPDATE site_statistics_settings SET contacts_started_at=(SELECT min(created_at) FROM directory_contact_inquiries),contacts_backfilled_at=now() WHERE id=1;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION record_directory_contact_statistic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contact_day DATE := (NEW.created_at AT TIME ZONE 'Europe/Budapest')::date;
BEGIN
 INSERT INTO site_statistics_days(day,contacts) VALUES(contact_day,1)
  ON CONFLICT(day) DO UPDATE SET contacts=site_statistics_days.contacts+1;
 IF NEW.listing_id IS NOT NULL THEN
  INSERT INTO site_statistics_pages(day,kind,entity_id,contacts) VALUES(contact_day,'listing',NEW.listing_id,1)
   ON CONFLICT(day,kind,entity_id) DO UPDATE SET contacts=site_statistics_pages.contacts+1;
 END IF;
 UPDATE site_statistics_settings SET contacts_started_at=LEAST(contacts_started_at,NEW.created_at) WHERE id=1;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS directory_contact_statistic ON directory_contact_inquiries;
CREATE TRIGGER directory_contact_statistic AFTER INSERT ON directory_contact_inquiries FOR EACH ROW EXECUTE FUNCTION record_directory_contact_statistic();
