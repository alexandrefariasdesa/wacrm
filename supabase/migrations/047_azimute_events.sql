-- ============================================================
-- 047_azimute_events.sql
--
-- Avisa o Azimute (painel de tráfego) quando um negócio é qualificado.
-- Fila própria: a `conversion_events` (044) exige ad_account_id, que
-- hoje está vazio. O trigger só INSERE na fila — nunca chama a rede —,
-- então mover um card nunca falha nem espera o Azimute.
-- A entrega é feita por GET /api/azimute/cron (pg_cron, 1 min).
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS azimute_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('qualified')),
  occurred_at     TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','skipped','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  claimed_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id, kind)
);

CREATE INDEX IF NOT EXISTS azimute_events_due_idx
  ON azimute_events (next_attempt_at) WHERE status IN ('pending','sending');

ALTER TABLE azimute_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS azimute_events_select ON azimute_events;
CREATE POLICY azimute_events_select ON azimute_events
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de escrita, de propósito: só o trigger (SECURITY DEFINER) e o worker (service_role).

CREATE OR REPLACE FUNCTION enqueue_azimute_qualified()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.qualified_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.qualified_at IS NULL) THEN
    INSERT INTO azimute_events (account_id, deal_id, contact_id, kind, occurred_at)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, 'qualified', NEW.qualified_at)
    ON CONFLICT (deal_id, kind) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS enqueue_azimute_qualified ON deals;
CREATE TRIGGER enqueue_azimute_qualified AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_azimute_qualified();

DROP FUNCTION IF EXISTS claim_azimute_events(int);
CREATE FUNCTION claim_azimute_events(batch int DEFAULT 20)
RETURNS SETOF azimute_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Travado em 'sending' há > 5 min: volta a pending, ou falha se já esgotou as 5 tentativas.
  UPDATE azimute_events
     SET status     = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
         last_error = CASE WHEN attempts >= 5 THEN 'travou durante o envio' ELSE last_error END
   WHERE status = 'sending' AND claimed_at < now() - interval '5 minutes';

  RETURN QUERY
  WITH due AS (
    SELECT id FROM azimute_events
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at
     LIMIT batch
     FOR UPDATE SKIP LOCKED
  )
  UPDATE azimute_events e
     SET status = 'sending', attempts = e.attempts + 1, claimed_at = now()
    FROM due
   WHERE e.id = due.id
  RETURNING e.*;
END;
$fn$;

REVOKE ALL ON FUNCTION claim_azimute_events(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_azimute_events(int) TO service_role;
