-- Only future submissions are queued. Existing applications are not backfilled.
CREATE TABLE IF NOT EXISTS directory_submission_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id BIGINT NOT NULL REFERENCES directory_submissions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('new','resubmitted')),
  recipient TEXT NOT NULL DEFAULT 'den@proptechdigital.com' CHECK (recipient='den@proptechdigital.com'),
  delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','needs_mail','sending','accepted','failed','uncertain','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sending_since TIMESTAMPTZ,
  provider_message_id TEXT,
  error_code TEXT,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_submission_notifications_pending ON directory_submission_notifications(next_attempt_at,created_at)
  WHERE delivery_status IN ('queued','needs_mail');

CREATE OR REPLACE FUNCTION queue_directory_submission_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_revision INTEGER;
BEGIN
  IF NEW.status IS DISTINCT FROM 'new' OR NEW.consent IS NOT TRUE OR NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status NOT IN ('reviewed','rejected') THEN RETURN NEW; END IF;
    UPDATE directory_submission_notifications SET delivery_status='cancelled',error_code='SUPERSEDED',updated_at=now()
      WHERE submission_id=NEW.id AND delivery_status IN ('queued','needs_mail','failed');
  END IF;
  SELECT COALESCE(MAX(revision),0)+1 INTO next_revision FROM directory_submission_notifications WHERE submission_id=NEW.id;
  INSERT INTO directory_submission_notifications(submission_id,revision,event_type)
    VALUES(NEW.id,next_revision,CASE WHEN TG_OP='INSERT' THEN 'new' ELSE 'resubmitted' END);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_directory_submission_notification ON directory_submissions;
CREATE TRIGGER trg_directory_submission_notification AFTER INSERT OR UPDATE OF status ON directory_submissions
  FOR EACH ROW EXECUTE FUNCTION queue_directory_submission_notification();
