CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  integration_id text NOT NULL REFERENCES integrations(id),
  event_type text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_status_check
    CHECK (status IN ('pending', 'delivering', 'failed', 'delivered', 'dead', 'discarded')),
  CONSTRAINT webhook_deliveries_attempts_check CHECK (attempts >= 0),
  CONSTRAINT webhook_deliveries_integration_dedupe_uidx UNIQUE (integration_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_org_created_idx
  ON webhook_deliveries (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION facility_webhook_event_enabled(config jsonb, event_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    NOT (config ? 'events')
    OR config->'events' = '[]'::jsonb
    OR config->'events' ? event_name;
$$;

CREATE OR REPLACE FUNCTION facility_queue_run_webhook()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status IN ('succeeded', 'failed', 'canceled') THEN
    INSERT INTO webhook_deliveries (
      id, org_id, integration_id, event_type, dedupe_key, payload
    )
    SELECT
      'whd_' || md5(integration.id || ':run.finished:' || NEW.id || ':' || NEW.status),
      NEW.org_id,
      integration.id,
      'run.finished',
      'run.finished:' || NEW.id || ':' || NEW.status,
      jsonb_build_object(
        'event', 'run.finished',
        'runId', NEW.id,
        'projectId', NEW.project_id,
        'agentDefId', NEW.agent_def_id,
        'status', NEW.status,
        'error', NEW.error,
        'endedAt', NEW.ended_at
      )
    FROM integrations AS integration
    WHERE integration.org_id = NEW.org_id
      AND integration.kind = 'webhook'
      AND integration.enabled = true
      AND (integration.project_id IS NULL OR integration.project_id = NEW.project_id)
      AND facility_webhook_event_enabled(integration.config, 'run.finished')
    ON CONFLICT (integration_id, dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facility_runs_webhook_outbox ON runs;
CREATE TRIGGER facility_runs_webhook_outbox
AFTER UPDATE OF status ON runs
FOR EACH ROW EXECUTE FUNCTION facility_queue_run_webhook();

CREATE OR REPLACE FUNCTION facility_queue_proposal_webhook()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.decided_at IS NULL AND NEW.decided_at IS NOT NULL THEN
    INSERT INTO webhook_deliveries (
      id, org_id, integration_id, event_type, dedupe_key, payload
    )
    SELECT
      'whd_' || md5(integration.id || ':proposal.decided:' || NEW.id),
      NEW.org_id,
      integration.id,
      'proposal.decided',
      'proposal.decided:' || NEW.id,
      jsonb_build_object(
        'event', 'proposal.decided',
        'proposalId', NEW.id,
        'projectId', NEW.project_id,
        'runId', NEW.run_id,
        'state', NEW.state,
        'decidedBy', NEW.decided_by,
        'decidedAt', NEW.decided_at
      )
    FROM integrations AS integration
    WHERE integration.org_id = NEW.org_id
      AND integration.kind = 'webhook'
      AND integration.enabled = true
      AND (integration.project_id IS NULL OR integration.project_id = NEW.project_id)
      AND facility_webhook_event_enabled(integration.config, 'proposal.decided')
    ON CONFLICT (integration_id, dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facility_proposals_webhook_outbox ON proposals;
CREATE TRIGGER facility_proposals_webhook_outbox
AFTER UPDATE OF decided_at ON proposals
FOR EACH ROW EXECUTE FUNCTION facility_queue_proposal_webhook();
