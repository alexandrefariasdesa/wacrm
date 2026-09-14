-- ============================================================
-- 045_deal_lost_reason.sql
--
-- Motivo de perda: o que o criativo atraiu de errado.
--
-- Uma etapa a mais diz ONDE o lead parou; o motivo diz POR QUÊ. Dois
-- criativos com o mesmo custo por qualificado podem perder por razões
-- opostas — um atrai quem não tem perfil (a promessa está errada), outro
-- atrai quem não responde (o lead é curioso, não comprador). A decisão
-- sobre cada um é diferente.
--
-- Lista FECHADA de códigos, e não texto livre: "sem grana", "s/ dinheiro"
-- e "não tem dinheiro" viram três linhas num relatório agrupado. O rótulo
-- legível fica na interface (i18n).
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason TEXT;

DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'deals_lost_reason_check' AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals ADD CONSTRAINT deals_lost_reason_check CHECK (
      lost_reason IS NULL OR lost_reason IN (
        'no_profile',      -- sem perfil (idade, escolaridade, concurso errado)
        'no_money',        -- sem dinheiro agora
        'no_response',     -- não respondeu depois das tentativas combinadas
        'thinking',        -- vai pensar / sumiu depois da oferta
        'bought_elsewhere',-- comprou de outro
        'other'
      )
    );
  END IF;
END
$chk$;

-- Motivo só existe em negócio perdido: reabrir ou ganhar limpa. Sem isso,
-- um negócio perdido por "vai pensar" e depois ganho continuaria contando
-- no relatório de perdas.
CREATE OR REPLACE FUNCTION clear_lost_reason()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM 'lost' THEN
    NEW.lost_reason = NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS clear_lost_reason ON deals;
CREATE TRIGGER clear_lost_reason BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION clear_lost_reason();

-- O histórico guarda o motivo do momento em que perdeu.
ALTER TABLE deal_stage_events ADD COLUMN IF NOT EXISTS lost_reason TEXT;

CREATE OR REPLACE FUNCTION log_deal_stage_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_name TEXT;
  v_position INTEGER;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     -- Motivo corrigido depois de perder também entra no histórico.
     AND NEW.lost_reason IS NOT DISTINCT FROM OLD.lost_reason THEN
    RETURN NULL;
  END IF;

  SELECT name, position INTO v_name, v_position
    FROM pipeline_stages WHERE id = NEW.stage_id;

  INSERT INTO deal_stage_events (
    account_id, deal_id, pipeline_id, contact_id,
    from_stage_id, to_stage_id, to_stage_name, to_stage_position,
    from_status, to_status, lost_reason, changed_by, source
  ) VALUES (
    NEW.account_id, NEW.id, NEW.pipeline_id, NEW.contact_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END,
    NEW.stage_id, v_name, v_position,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
    NEW.status,
    NEW.lost_reason,
    auth.uid(),
    'trigger'
  );
  RETURN NULL;
END;
$fn$;

-- ------------------------------------------------------------
-- ad_lost_reasons — perdidos por motivo, por grupo
--
-- Mesma coorte do funil (044): leads que chegaram no período, negócios
-- deles neste funil que estão perdidos HOJE.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS ad_lost_reasons(UUID, DATE, DATE, UUID, TEXT, TEXT);
CREATE FUNCTION ad_lost_reasons(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_pipeline_id UUID,
  p_level TEXT DEFAULT 'ad',
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  group_key TEXT,
  reason TEXT,
  lost BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $fn$
BEGIN
  IF p_level NOT IN ('ad', 'adset', 'campaign', 'platform') THEN
    RAISE EXCEPTION 'nivel invalido: %', p_level;
  END IF;

  RETURN QUERY
  WITH leads AS (
    SELECT
      a.contact_id,
      CASE p_level
        WHEN 'ad'       THEN COALESCE(a.ad_id::TEXT, 'ext:' || a.ad_external_id, 'unknown')
        WHEN 'adset'    THEN COALESCE(a.ad_group_id::TEXT, 'unknown')
        WHEN 'campaign' THEN COALESCE(a.campaign_id::TEXT, 'unknown')
        ELSE a.platform
      END AS k
    FROM ad_attributed_leads(p_account_id, p_attribution) a
    WHERE a.occurred_at >= p_from::TIMESTAMPTZ
      AND a.occurred_at < (p_to + 1)::TIMESTAMPTZ
  )
  SELECT
    l.k::TEXT,
    COALESCE(d.lost_reason, 'unspecified')::TEXT,
    COUNT(DISTINCT d.id)::BIGINT
  FROM leads l
  JOIN deals d
    ON d.account_id = p_account_id
   AND d.contact_id = l.contact_id
   AND d.pipeline_id = p_pipeline_id
   AND d.status = 'lost'
  GROUP BY l.k, COALESCE(d.lost_reason, 'unspecified')
  ORDER BY l.k, 3 DESC;
END;
$fn$;

GRANT EXECUTE ON FUNCTION ad_lost_reasons(UUID, DATE, DATE, UUID, TEXT, TEXT) TO authenticated;
