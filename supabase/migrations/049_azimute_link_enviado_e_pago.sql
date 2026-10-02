-- ============================================================
-- 049_azimute_link_enviado_e_pago.sql
--
-- Além de "qualificado" (047), o Azimute passa a receber "link enviado" e
-- "pago". Pago = negócio ganho (`status='won'`). Link enviado = o negócio
-- chegou na etapa marcada `is_payment_link` OU numa posterior (ou foi
-- ganho direto) e congelado como o qualified_at. Diferente do qualified_at,
-- NÃO usa "etapa posterior": o funil tem etapas depois do link que não
-- significam link enviado (Negativa, ligar amanhã). Conta só ter ENTRADO
-- na etapa marcada.
-- Idempotente.
-- ============================================================

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS is_payment_link BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_one_payment_link
  ON pipeline_stages(pipeline_id) WHERE is_payment_link;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS link_sent_at TIMESTAMPTZ;

ALTER TABLE azimute_events DROP CONSTRAINT IF EXISTS azimute_events_kind_check;
ALTER TABLE azimute_events
  ADD CONSTRAINT azimute_events_kind_check
  CHECK (kind IN ('qualified','link_sent','paid'));

-- link_sent_at — BEFORE, grava na mesma linha (sem lista de colunas, pelo
-- mesmo motivo explicado na 044).
CREATE OR REPLACE FUNCTION stamp_deal_link_sent_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.link_sent_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'won' THEN
    NEW.link_sent_at = NOW();
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM pipeline_stages
              WHERE id = NEW.stage_id AND is_payment_link) THEN
    NEW.link_sent_at = NOW();
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS stamp_link_sent_at ON deals;
CREATE TRIGGER stamp_link_sent_at BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION stamp_deal_link_sent_at();

-- Marcar a etapa depois do fato: carimba os negócios que já passaram dela.
CREATE OR REPLACE FUNCTION backfill_link_sent_on_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT NEW.is_payment_link THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_payment_link THEN
    RETURN NULL;
  END IF;

  UPDATE deals d
     SET link_sent_at = COALESCE(
           (SELECT MIN(e.occurred_at)
              FROM deal_stage_events e
             WHERE e.deal_id = d.id AND e.to_stage_id = NEW.id),
           d.won_at,
           d.updated_at,
           d.created_at
         )
   WHERE d.pipeline_id = NEW.pipeline_id
     AND d.link_sent_at IS NULL
     AND (d.stage_id = NEW.id
          OR d.status = 'won'
          OR EXISTS (SELECT 1 FROM deal_stage_events e
                      WHERE e.deal_id = d.id AND e.to_stage_id = NEW.id));

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS backfill_link_sent ON pipeline_stages;
CREATE TRIGGER backfill_link_sent AFTER INSERT OR UPDATE ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION backfill_link_sent_on_flag();

-- Fila para o Azimute: link enviado e pago.
CREATE OR REPLACE FUNCTION enqueue_azimute_link_sent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.link_sent_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.link_sent_at IS NULL) THEN
    INSERT INTO azimute_events (account_id, deal_id, contact_id, kind, occurred_at)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, 'link_sent', NEW.link_sent_at)
    ON CONFLICT (deal_id, kind) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS enqueue_azimute_link_sent ON deals;
CREATE TRIGGER enqueue_azimute_link_sent AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_azimute_link_sent();

CREATE OR REPLACE FUNCTION enqueue_azimute_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status = 'won'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'won') THEN
    INSERT INTO azimute_events (account_id, deal_id, contact_id, kind, occurred_at)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, 'paid', COALESCE(NEW.won_at, NOW()))
    ON CONFLICT (deal_id, kind) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS enqueue_azimute_paid ON deals;
CREATE TRIGGER enqueue_azimute_paid AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_azimute_paid();

-- Negócios já ganhos entram na fila uma vez.
INSERT INTO azimute_events (account_id, deal_id, contact_id, kind, occurred_at)
SELECT account_id, id, contact_id, 'paid', COALESCE(won_at, updated_at, created_at)
  FROM deals WHERE status = 'won'
ON CONFLICT (deal_id, kind) DO NOTHING;
