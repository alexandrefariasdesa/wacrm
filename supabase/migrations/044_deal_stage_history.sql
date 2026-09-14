-- ============================================================
-- 044_deal_stage_history.sql
--
-- O funil comercial por criativo: quanto custa cada ETAPA, não só o lead.
--
-- Até a 043 o painel sabia duas coisas de um negócio: que ele existe e,
-- se for o caso, quando foi ganho (`won_at`). Tudo o que acontece entre
-- uma coisa e outra — o vendedor arrastar o card para "Qualificado", para
-- "Reunião", para "Proposta" — era um UPDATE em `deals.stage_id` que
-- sobrescrevia a etapa anterior sem deixar rastro. Custo por lead
-- qualificado era impossível de calcular: o dado não existia.
--
-- Esta migration:
--
--   1. `deal_stage_events` — histórico IMUTÁVEL de cada entrada em etapa
--      e de cada mudança de status, gravado por trigger. Ninguém escreve
--      nele pela API nem pelo navegador (não há policy de escrita).
--   2. `pipeline_stages.is_qualification` — o admin marca QUAL etapa do
--      funil significa "lead qualificado". Uma por funil.
--   3. `deals.qualified_at` — o instante em que o negócio chegou pela
--      primeira vez à etapa de qualificação OU a qualquer etapa depois
--      dela (vendedor que pula direto para "Reunião" também qualificou).
--      Congelado: nunca é apagado, nem se o negócio for perdido depois.
--   4. `pipelines.receives_api_leads` — o funil onde o lead do formulário
--      (POST /api/v1/leads) já nasce como negócio na primeira etapa.
--   5. `conversion_events` — a fila de eventos para a Conversions API da
--      Meta ("lead qualificado" e "venda"), preenchida por trigger e
--      esvaziada pelo cron.
--   6. `ad_clicks`/`attribution_touches` ganham o conjunto de anúncios e
--      os cookies da Meta (`_fbc`/`_fbp`), que a Conversions API usa para
--      casar o evento com quem clicou.
--   7. As funções do painel são refeitas com o nível "conjunto", a coluna
--      de qualificados e o funil por etapa (`ad_stage_funnel`).
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Marcações no funil
-- ------------------------------------------------------------
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS is_qualification BOOLEAN NOT NULL DEFAULT FALSE;

-- Uma etapa de qualificação por funil. Duas deixariam "chegou à
-- qualificação" ambíguo quando a ordem das etapas muda.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_one_qualification
  ON pipeline_stages(pipeline_id) WHERE is_qualification;

ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS receives_api_leads BOOLEAN NOT NULL DEFAULT FALSE;

-- Um funil de entrada por conta: o formulário não sabe escolher entre dois.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_one_api_inbox
  ON pipelines(account_id) WHERE receives_api_leads;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_deals_qualified_at
  ON deals(account_id, qualified_at) WHERE qualified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(contact_id);

-- ------------------------------------------------------------
-- 2. deal_stage_events — o histórico
--
-- Guarda o NOME e a POSIÇÃO da etapa no momento da mudança, além do id.
-- Etapa renomeada, reordenada ou apagada depois não reescreve o passado:
-- o funil de março continua dizendo o que o time viu em março.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_stage_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  from_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_name TEXT,
  to_stage_position INTEGER,
  from_status TEXT,
  to_status TEXT,
  -- Quem mexeu. NULL quando foi a API, uma automação ou o backfill.
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 'trigger' = mudança real capturada ao vivo; 'backfill' = o estado em
  -- que o negócio já estava quando esta migration rodou (sem data real
  -- de entrada, usa a criação do negócio).
  source TEXT NOT NULL DEFAULT 'trigger' CHECK (source IN ('trigger', 'backfill')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal
  ON deal_stage_events(deal_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_account
  ON deal_stage_events(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_stage
  ON deal_stage_events(to_stage_id);

ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_stage_events_select ON deal_stage_events;
CREATE POLICY deal_stage_events_select ON deal_stage_events
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de INSERT/UPDATE/DELETE, de propósito: histórico que o
-- navegador consegue editar não é histórico. Só o trigger (SECURITY
-- DEFINER) escreve.

-- ------------------------------------------------------------
-- 3. Triggers em deals
--
-- Sem lista de colunas (`UPDATE OF stage_id`) de propósito: o Postgres só
-- dispara o trigger com lista quando a coluna aparece no SET do comando,
-- e ignora mudança feita por outro trigger BEFORE. A comparação OLD/NEW
-- dentro da função é a forma que não falha calada.
-- ------------------------------------------------------------

-- 3a. qualified_at — BEFORE, para gravar na mesma linha.
CREATE OR REPLACE FUNCTION stamp_deal_qualified_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_stage_position INTEGER;
  v_qual_position  INTEGER;
BEGIN
  -- Congelado: uma vez qualificado, sempre qualificado. Um lead que
  -- qualificou e depois foi perdido CUSTOU como qualificado — apagar o
  -- carimbo faria o custo por qualificado melhorar quando a venda piora.
  IF NEW.qualified_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'won' THEN
    NEW.qualified_at = NOW();
    RETURN NEW;
  END IF;

  SELECT position INTO v_stage_position
    FROM pipeline_stages WHERE id = NEW.stage_id;
  SELECT position INTO v_qual_position
    FROM pipeline_stages
   WHERE pipeline_id = NEW.pipeline_id AND is_qualification
   LIMIT 1;

  IF v_qual_position IS NOT NULL
     AND v_stage_position IS NOT NULL
     AND v_stage_position >= v_qual_position THEN
    NEW.qualified_at = NOW();
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS stamp_qualified_at ON deals;
CREATE TRIGGER stamp_qualified_at BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION stamp_deal_qualified_at();

-- 3b. histórico — AFTER, quando a linha já passou por todos os BEFORE.
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
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  SELECT name, position INTO v_name, v_position
    FROM pipeline_stages WHERE id = NEW.stage_id;

  INSERT INTO deal_stage_events (
    account_id, deal_id, pipeline_id, contact_id,
    from_stage_id, to_stage_id, to_stage_name, to_stage_position,
    from_status, to_status, changed_by, source
  ) VALUES (
    NEW.account_id, NEW.id, NEW.pipeline_id, NEW.contact_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END,
    NEW.stage_id, v_name, v_position,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
    NEW.status,
    auth.uid(),
    'trigger'
  );
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS log_stage_event ON deals;
CREATE TRIGGER log_stage_event AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION log_deal_stage_event();

-- 3c. Backfill do histórico: o estado atual de cada negócio vira UM
--     evento, datado da criação. É o que dá para afirmar sem inventar.
INSERT INTO deal_stage_events (
  account_id, deal_id, pipeline_id, contact_id, to_stage_id,
  to_stage_name, to_stage_position, to_status, source, occurred_at
)
SELECT d.account_id, d.id, d.pipeline_id, d.contact_id, d.stage_id,
       s.name, s.position, d.status, 'backfill',
       COALESCE(d.created_at, NOW())
  FROM deals d
  LEFT JOIN pipeline_stages s ON s.id = d.stage_id
 WHERE NOT EXISTS (SELECT 1 FROM deal_stage_events e WHERE e.deal_id = d.id);

-- ------------------------------------------------------------
-- 4. Marcar a etapa de qualificação DEPOIS de ter negócios no funil
--
-- O caso normal: o funil já roda há semanas quando alguém decide qual
-- etapa é "qualificado". Sem isto, todo negócio que já passou dela ficaria
-- sem `qualified_at` para sempre (o trigger de deals só olha mudanças
-- futuras). A data usada é a primeira entrada registrada numa etapa igual
-- ou posterior; sem histórico, a última atualização do negócio.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_qualified_on_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT NEW.is_qualification THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_qualification THEN
    RETURN NULL;
  END IF;

  UPDATE deals d
     SET qualified_at = COALESCE(
           (SELECT MIN(e.occurred_at)
              FROM deal_stage_events e
              JOIN pipeline_stages es ON es.id = e.to_stage_id
             WHERE e.deal_id = d.id
               AND es.position >= NEW.position),
           d.won_at,
           d.updated_at,
           d.created_at
         )
    FROM pipeline_stages cur
   WHERE d.pipeline_id = NEW.pipeline_id
     AND d.qualified_at IS NULL
     AND cur.id = d.stage_id
     AND (cur.position >= NEW.position OR d.status = 'won');

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS backfill_qualified ON pipeline_stages;
CREATE TRIGGER backfill_qualified AFTER INSERT OR UPDATE ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION backfill_qualified_on_flag();

-- ------------------------------------------------------------
-- 5. Mais sinal no clique e no toque
-- ------------------------------------------------------------
ALTER TABLE ad_clicks
  ADD COLUMN IF NOT EXISTS adset_external_id TEXT,
  -- Cookies da Meta lidos na landing page. `_fbc` é o fbclid carimbado com
  -- a hora do clique; `_fbp` identifica o navegador. São as duas chaves
  -- que mais sobem a taxa de correspondência na Conversions API.
  ADD COLUMN IF NOT EXISTS fbc TEXT,
  ADD COLUMN IF NOT EXISTS fbp TEXT,
  -- {{placement}} da Meta: feed, stories, reels...
  ADD COLUMN IF NOT EXISTS placement TEXT;

ALTER TABLE attribution_touches
  ADD COLUMN IF NOT EXISTS adset_external_id TEXT,
  ADD COLUMN IF NOT EXISTS ad_group_id UUID REFERENCES ad_groups(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 6. Conversions API: configuração e fila
-- ------------------------------------------------------------
ALTER TABLE ad_accounts
  ADD COLUMN IF NOT EXISTS capi_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- O pixel / conjunto de dados que recebe os eventos.
  ADD COLUMN IF NOT EXISTS capi_dataset_id TEXT,
  -- Nomes PERSONALIZADOS por padrão, e não `Lead`/`Purchase`: a landing
  -- page já dispara `Lead` e o checkout já dispara `Purchase` no mesmo
  -- pixel. Reusar os nomes padrão contaria a mesma pessoa duas vezes.
  ADD COLUMN IF NOT EXISTS capi_qualified_event TEXT NOT NULL DEFAULT 'LeadQualificado',
  ADD COLUMN IF NOT EXISTS capi_won_event TEXT NOT NULL DEFAULT 'VendaFechada',
  -- Código de teste do Gerenciador de Eventos. Com ele preenchido os
  -- eventos aparecem em "Testar eventos" e NÃO entram na otimização.
  ADD COLUMN IF NOT EXISTS capi_test_event_code TEXT;

CREATE TABLE IF NOT EXISTS conversion_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('qualified', 'won')),
  event_name TEXT NOT NULL,
  -- `<deal>:<kind>`. Estável entre reenvios: a Meta deduplica por ele, e
  -- o índice único abaixo impede o mesmo evento de entrar duas vezes na
  -- fila (negócio reaberto e ganho de novo não gera segunda venda).
  event_id TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  value NUMERIC(14, 2),
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ad_account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_conversion_events_pending
  ON conversion_events(created_at) WHERE status IN ('pending', 'failed');

ALTER TABLE conversion_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversion_events_select ON conversion_events;
CREATE POLICY conversion_events_select ON conversion_events
  FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION enqueue_conversion_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.qualified_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.qualified_at IS NULL) THEN
    INSERT INTO conversion_events (
      account_id, ad_account_id, deal_id, contact_id, kind,
      event_name, event_id, event_time
    )
    SELECT NEW.account_id, aa.id, NEW.id, NEW.contact_id, 'qualified',
           aa.capi_qualified_event, NEW.id::TEXT || ':qualified', NEW.qualified_at
      FROM ad_accounts aa
     WHERE aa.account_id = NEW.account_id
       AND aa.platform = 'meta'
       AND aa.capi_enabled
       AND aa.capi_dataset_id IS NOT NULL
    ON CONFLICT (ad_account_id, event_id) DO NOTHING;
  END IF;

  IF NEW.won_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.won_at IS NULL) THEN
    INSERT INTO conversion_events (
      account_id, ad_account_id, deal_id, contact_id, kind,
      event_name, event_id, event_time, value, currency
    )
    SELECT NEW.account_id, aa.id, NEW.id, NEW.contact_id, 'won',
           aa.capi_won_event, NEW.id::TEXT || ':won', NEW.won_at,
           NEW.value, NEW.currency
      FROM ad_accounts aa
     WHERE aa.account_id = NEW.account_id
       AND aa.platform = 'meta'
       AND aa.capi_enabled
       AND aa.capi_dataset_id IS NOT NULL
    ON CONFLICT (ad_account_id, event_id) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS enqueue_conversions ON deals;
CREATE TRIGGER enqueue_conversions AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_conversion_events();

-- ------------------------------------------------------------
-- 7. As funções do painel
--
-- Mudam de assinatura de retorno (coluna nova), e CREATE OR REPLACE não
-- troca o tipo de retorno — por isso DROP antes.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS ad_performance(UUID, DATE, DATE, TEXT, TEXT);
DROP FUNCTION IF EXISTS ad_overview(UUID, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS ad_daily_series(UUID, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS ad_attributed_leads(UUID, TEXT);
DROP FUNCTION IF EXISTS ad_stage_funnel(UUID, DATE, DATE, UUID, TEXT, TEXT);

-- ------------------------------------------------------------
-- ad_attributed_leads — UM toque por contato, já com a hierarquia
--
-- Era repetido nas três funções da 041. Virou uma só, e ganhou o que
-- faltava: resolver o anúncio pelo id cru quando o toque ainda não foi
-- religado. Sem isso, um criativo novo aparecia em DUAS linhas (o gasto
-- no anúncio sincronizado, os leads em 'ext:<id>') até o próximo sync.
-- ------------------------------------------------------------
CREATE FUNCTION ad_attributed_leads(
  p_account_id UUID,
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  contact_id UUID,
  conversation_id UUID,
  occurred_at TIMESTAMPTZ,
  platform TEXT,
  ad_id UUID,
  ad_external_id TEXT,
  ad_group_id UUID,
  campaign_id UUID,
  ad_name TEXT,
  ad_status TEXT,
  ad_thumb TEXT,
  group_name TEXT,
  group_status TEXT,
  campaign_name TEXT,
  campaign_status TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $fn$
  WITH ranked AS (
    SELECT t.*,
      ROW_NUMBER() OVER (
        PARTITION BY t.contact_id
        ORDER BY
          CASE WHEN p_attribution = 'last'
               THEN -EXTRACT(EPOCH FROM t.occurred_at)
               ELSE  EXTRACT(EPOCH FROM t.occurred_at)
          END ASC,
          t.id ASC
      ) AS rn
    FROM attribution_touches t
    WHERE t.account_id = p_account_id
  )
  SELECT
    r.contact_id,
    r.conversation_id,
    r.occurred_at,
    COALESCE(a.platform, r.platform)::TEXT,
    a.id,
    COALESCE(r.ad_external_id, a.external_id),
    COALESCE(r.ad_group_id, a.ad_group_id),
    COALESCE(r.campaign_id, a.campaign_id),
    a.name, a.status, a.thumbnail_url,
    g.name, g.status,
    c.name, c.status
  FROM ranked r
  LEFT JOIN LATERAL (
    SELECT x.* FROM ads x
     WHERE x.id = r.ad_id
        OR (r.ad_id IS NULL AND r.ad_external_id IS NOT NULL
            AND x.account_id = p_account_id
            AND x.external_id = r.ad_external_id)
     ORDER BY (x.id = r.ad_id) DESC NULLS LAST
     LIMIT 1
  ) a ON TRUE
  LEFT JOIN ad_groups g    ON g.id = COALESCE(r.ad_group_id, a.ad_group_id)
  LEFT JOIN ad_campaigns c ON c.id = COALESCE(r.campaign_id, a.campaign_id)
  WHERE r.rn = 1;
$fn$;

-- ------------------------------------------------------------
-- ad_performance — uma linha por anúncio / conjunto / campanha / plataforma
--
-- Colunas novas: `qualified` (dos leads que chegaram no período, quantos
-- já passaram pela etapa de qualificação em QUALQUER data, até agora).
--
-- Por que qualificado conta pela data do LEAD e não pela data em que
-- qualificou, ao contrário da receita: a pergunta é "o dinheiro que eu
-- pus neste criativo nesta semana trouxe quantos leads bons". O gasto da
-- semana gerou os leads da semana; se eles qualificam na semana seguinte,
-- continuam sendo fruto daquele gasto. Contar pela data da qualificação
-- jogaria o bom resultado de um criativo para a semana em que ele talvez
-- já estivesse pausado.
-- ------------------------------------------------------------
CREATE FUNCTION ad_performance(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_level TEXT DEFAULT 'ad',
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  group_key TEXT,
  label TEXT,
  platform TEXT,
  campaign_label TEXT,
  status TEXT,
  thumbnail_url TEXT,
  spend NUMERIC,
  impressions BIGINT,
  clicks BIGINT,
  leads BIGINT,
  qualified BIGINT,
  conversations BIGINT,
  deals_won BIGINT,
  revenue NUMERIC,
  spend_currency TEXT,
  revenue_currency TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $fn$
BEGIN
  IF p_level NOT IN ('ad', 'adset', 'campaign', 'platform') THEN
    RAISE EXCEPTION 'nivel invalido: %', p_level;
  END IF;
  IF p_attribution NOT IN ('first', 'last') THEN
    RAISE EXCEPTION 'modelo de atribuicao invalido: %', p_attribution;
  END IF;

  RETURN QUERY
  WITH
  attributed AS (
    SELECT * FROM ad_attributed_leads(p_account_id, p_attribution)
  ),

  -- GASTO — pelo dia da plataforma.
  spend_rows AS (
    SELECT
      CASE p_level
        WHEN 'ad'       THEN COALESCE(i.ad_id::TEXT, 'ext:' || i.ad_external_id, 'unknown')
        WHEN 'adset'    THEN COALESCE(COALESCE(i.ad_group_id, a.ad_group_id)::TEXT, 'unknown')
        WHEN 'campaign' THEN COALESCE(COALESCE(i.campaign_id, a.campaign_id)::TEXT, 'unknown')
        ELSE i.platform
      END AS k,
      CASE p_level
        WHEN 'ad'       THEN a.name
        WHEN 'adset'    THEN g.name
        WHEN 'campaign' THEN c.name
        ELSE i.platform
      END AS lbl,
      CASE p_level
        WHEN 'ad'       THEN a.status
        WHEN 'adset'    THEN g.status
        WHEN 'campaign' THEN c.status
        ELSE NULL
      END AS st,
      CASE WHEN p_level = 'ad' THEN a.thumbnail_url ELSE NULL END AS thumb,
      CASE WHEN p_level IN ('ad', 'adset') THEN c.name ELSE NULL END AS camp_lbl,
      i.platform AS plat,
      i.spend, i.impressions, i.clicks, i.currency
    FROM ad_insights_daily i
    LEFT JOIN ads a          ON a.id = i.ad_id
    LEFT JOIN ad_groups g    ON g.id = COALESCE(i.ad_group_id, a.ad_group_id)
    LEFT JOIN ad_campaigns c ON c.id = COALESCE(i.campaign_id, a.campaign_id)
    WHERE i.account_id = p_account_id
      AND i.date >= p_from
      AND i.date <= p_to
  ),
  spend_agg AS (
    SELECT
      sr.k,
      MAX(sr.lbl)      AS lbl,
      MAX(sr.st)       AS st,
      MAX(sr.thumb)    AS thumb,
      MAX(sr.camp_lbl) AS camp_lbl,
      MAX(sr.plat)     AS plat,
      SUM(sr.spend)                AS spend,
      SUM(sr.impressions)::BIGINT  AS impressions,
      SUM(sr.clicks)::BIGINT       AS clicks,
      MODE() WITHIN GROUP (ORDER BY sr.currency) AS currency
    FROM spend_rows sr
    GROUP BY sr.k
  ),

  -- Chave de agrupamento dos leads, calculada uma vez.
  keyed AS (
    SELECT
      at.*,
      CASE p_level
        WHEN 'ad'       THEN COALESCE(at.ad_id::TEXT, 'ext:' || at.ad_external_id, 'unknown')
        WHEN 'adset'    THEN COALESCE(at.ad_group_id::TEXT, 'unknown')
        WHEN 'campaign' THEN COALESCE(at.campaign_id::TEXT, 'unknown')
        ELSE at.platform
      END AS k
    FROM attributed at
  ),

  -- LEADS / QUALIFICADOS / CONVERSAS — pelo dia do toque.
  lead_agg AS (
    SELECT
      kd.k,
      MAX(CASE p_level
            WHEN 'ad'       THEN kd.ad_name
            WHEN 'adset'    THEN kd.group_name
            WHEN 'campaign' THEN kd.campaign_name
            ELSE kd.platform
          END) AS lbl,
      MAX(CASE p_level
            WHEN 'ad'       THEN kd.ad_status
            WHEN 'adset'    THEN kd.group_status
            WHEN 'campaign' THEN kd.campaign_status
            ELSE NULL
          END) AS st,
      MAX(CASE WHEN p_level = 'ad' THEN kd.ad_thumb ELSE NULL END) AS thumb,
      MAX(CASE WHEN p_level IN ('ad', 'adset') THEN kd.campaign_name ELSE NULL END) AS camp_lbl,
      MAX(kd.platform) AS plat,
      COUNT(DISTINCT kd.contact_id)::BIGINT AS leads,
      COUNT(DISTINCT kd.contact_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM deals d
           WHERE d.account_id = p_account_id
             AND d.contact_id = kd.contact_id
             AND d.qualified_at IS NOT NULL
             -- Qualificação que aconteceu ANTES do toque creditado é de
             -- outra passagem da pessoa, não fruto deste anúncio.
             AND d.qualified_at >= kd.occurred_at - INTERVAL '1 minute'
        )
      )::BIGINT AS qualified,
      COUNT(DISTINCT kd.conversation_id)::BIGINT AS conversations
    FROM keyed kd
    WHERE kd.occurred_at >= p_from::TIMESTAMPTZ
      AND kd.occurred_at < (p_to + 1)::TIMESTAMPTZ
    GROUP BY kd.k
  ),

  -- RECEITA — pelo dia em que o negócio foi ganho (regra da 041).
  deal_agg AS (
    SELECT
      kd.k,
      COUNT(DISTINCT d.id)::BIGINT AS deals_won,
      SUM(d.value)                 AS revenue,
      MODE() WITHIN GROUP (ORDER BY d.currency) AS currency
    FROM deals d
    JOIN keyed kd ON kd.contact_id = d.contact_id
    WHERE d.account_id = p_account_id
      AND d.status = 'won'
      AND d.won_at IS NOT NULL
      AND d.won_at >= p_from::TIMESTAMPTZ
      AND d.won_at < (p_to + 1)::TIMESTAMPTZ
    GROUP BY kd.k
  ),

  keys AS (
    SELECT sa.k FROM spend_agg sa
    UNION
    SELECT la.k FROM lead_agg la
    UNION
    SELECT da.k FROM deal_agg da
  )
  SELECT
    kk.k AS group_key,
    COALESCE(
      s.lbl,
      l.lbl,
      NULLIF(REPLACE(kk.k, 'ext:', ''), 'unknown')
    )::TEXT AS label,
    COALESCE(s.plat, l.plat, 'other')::TEXT AS platform,
    COALESCE(s.camp_lbl, l.camp_lbl)::TEXT  AS campaign_label,
    COALESCE(s.st, l.st)::TEXT              AS status,
    COALESCE(s.thumb, l.thumb)::TEXT        AS thumbnail_url,
    COALESCE(s.spend, 0)         AS spend,
    COALESCE(s.impressions, 0)   AS impressions,
    COALESCE(s.clicks, 0)        AS clicks,
    COALESCE(l.leads, 0)         AS leads,
    COALESCE(l.qualified, 0)     AS qualified,
    COALESCE(l.conversations, 0) AS conversations,
    COALESCE(dg.deals_won, 0)    AS deals_won,
    COALESCE(dg.revenue, 0)      AS revenue,
    s.currency                   AS spend_currency,
    dg.currency                  AS revenue_currency
  FROM keys kk
  LEFT JOIN spend_agg s  ON s.k = kk.k
  LEFT JOIN lead_agg  l  ON l.k = kk.k
  LEFT JOIN deal_agg  dg ON dg.k = kk.k
  ORDER BY COALESCE(s.spend, 0) DESC, COALESCE(l.leads, 0) DESC;
END;
$fn$;

-- ------------------------------------------------------------
-- ad_overview — os números do topo (com qualificados)
-- ------------------------------------------------------------
CREATE FUNCTION ad_overview(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  spend NUMERIC,
  impressions BIGINT,
  clicks BIGINT,
  attributed_leads BIGINT,
  qualified_leads BIGINT,
  organic_leads BIGINT,
  deals_won BIGINT,
  revenue NUMERIC,
  link_clicks BIGINT,
  link_clicks_matched BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $fn$
BEGIN
  RETURN QUERY
  WITH
  attributed AS (
    SELECT a.contact_id, a.occurred_at
      FROM ad_attributed_leads(p_account_id, p_attribution) a
  ),
  s AS (
    SELECT COALESCE(SUM(i.spend), 0) AS spend,
           COALESCE(SUM(i.impressions), 0)::BIGINT AS impressions,
           COALESCE(SUM(i.clicks), 0)::BIGINT AS clicks
    FROM ad_insights_daily i
    WHERE i.account_id = p_account_id AND i.date >= p_from AND i.date <= p_to
  ),
  al AS (
    SELECT
      COUNT(DISTINCT a.contact_id)::BIGINT AS n,
      COUNT(DISTINCT a.contact_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM deals d
           WHERE d.account_id = p_account_id
             AND d.contact_id = a.contact_id
             AND d.qualified_at IS NOT NULL
             AND d.qualified_at >= a.occurred_at - INTERVAL '1 minute'
        )
      )::BIGINT AS q
    FROM attributed a
    WHERE a.occurred_at >= p_from::TIMESTAMPTZ
      AND a.occurred_at < (p_to + 1)::TIMESTAMPTZ
  ),
  ol AS (
    SELECT COUNT(*)::BIGINT AS n
    FROM contacts c
    WHERE c.account_id = p_account_id
      AND c.created_at >= p_from::TIMESTAMPTZ
      AND c.created_at < (p_to + 1)::TIMESTAMPTZ
      AND NOT EXISTS (
        SELECT 1 FROM attribution_touches t WHERE t.contact_id = c.id
      )
  ),
  dg AS (
    SELECT COUNT(DISTINCT d.id)::BIGINT AS deals_won,
           COALESCE(SUM(d.value), 0) AS revenue
    FROM deals d
    JOIN attributed a ON a.contact_id = d.contact_id
    WHERE d.account_id = p_account_id
      AND d.status = 'won'
      AND d.won_at IS NOT NULL
      AND d.won_at >= p_from::TIMESTAMPTZ
      AND d.won_at < (p_to + 1)::TIMESTAMPTZ
  ),
  lc AS (
    SELECT COUNT(*)::BIGINT AS total,
           COUNT(*) FILTER (WHERE ac.matched_at IS NOT NULL)::BIGINT AS matched
    FROM ad_clicks ac
    WHERE ac.account_id = p_account_id
      AND ac.created_at >= p_from::TIMESTAMPTZ
      AND ac.created_at < (p_to + 1)::TIMESTAMPTZ
  )
  SELECT s.spend, s.impressions, s.clicks,
         al.n, al.q, ol.n, dg.deals_won, dg.revenue,
         lc.total, lc.matched
  FROM s, al, ol, dg, lc;
END;
$fn$;

-- ------------------------------------------------------------
-- ad_daily_series — a série do gráfico (com qualificados por dia do lead)
-- ------------------------------------------------------------
CREATE FUNCTION ad_daily_series(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  day DATE,
  spend NUMERIC,
  leads BIGINT,
  qualified BIGINT,
  revenue NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $fn$
BEGIN
  RETURN QUERY
  WITH
  days AS (SELECT generate_series(p_from, p_to, INTERVAL '1 day')::DATE AS d),
  attributed AS (
    SELECT a.contact_id, a.occurred_at
      FROM ad_attributed_leads(p_account_id, p_attribution) a
  ),
  sp AS (
    SELECT i.date AS d, SUM(i.spend) AS amount
    FROM ad_insights_daily i
    WHERE i.account_id = p_account_id AND i.date >= p_from AND i.date <= p_to
    GROUP BY i.date
  ),
  ld AS (
    SELECT a.occurred_at::DATE AS d,
           COUNT(DISTINCT a.contact_id) AS n,
           COUNT(DISTINCT a.contact_id) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM deals dd
                WHERE dd.account_id = p_account_id
                  AND dd.contact_id = a.contact_id
                  AND dd.qualified_at IS NOT NULL
                  AND dd.qualified_at >= a.occurred_at - INTERVAL '1 minute'
             )
           ) AS q
    FROM attributed a
    WHERE a.occurred_at >= p_from::TIMESTAMPTZ
      AND a.occurred_at < (p_to + 1)::TIMESTAMPTZ
    GROUP BY 1
  ),
  rv AS (
    SELECT d.won_at::DATE AS d, SUM(d.value) AS amount
    FROM deals d
    JOIN attributed a ON a.contact_id = d.contact_id
    WHERE d.account_id = p_account_id
      AND d.status = 'won'
      AND d.won_at IS NOT NULL
      AND d.won_at >= p_from::TIMESTAMPTZ
      AND d.won_at < (p_to + 1)::TIMESTAMPTZ
    GROUP BY 1
  )
  SELECT days.d,
         COALESCE(sp.amount, 0),
         COALESCE(ld.n, 0)::BIGINT,
         COALESCE(ld.q, 0)::BIGINT,
         COALESCE(rv.amount, 0)
  FROM days
  LEFT JOIN sp ON sp.d = days.d
  LEFT JOIN ld ON ld.d = days.d
  LEFT JOIN rv ON rv.d = days.d
  ORDER BY days.d;
END;
$fn$;

-- ------------------------------------------------------------
-- ad_stage_funnel — quantos leads de cada criativo chegaram a cada etapa
--
-- Uma linha por (grupo, etapa) do funil pedido. "Chegou" = em algum
-- momento esteve nesta etapa ou numa posterior (pela posição gravada no
-- histórico), ou foi ganho. Um lead que foi até "Proposta" e perdeu conta
-- em Novo, Qualificado, Reunião e Proposta — é isso que permite ver ONDE
-- cada criativo vaza.
--
-- Mesma coorte de `qualified`: leads que chegaram no período, olhando
-- tudo o que aconteceu com eles até agora.
-- ------------------------------------------------------------
CREATE FUNCTION ad_stage_funnel(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_pipeline_id UUID,
  p_level TEXT DEFAULT 'ad',
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  group_key TEXT,
  stage_id UUID,
  stage_name TEXT,
  stage_position INTEGER,
  reached BIGINT
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
  WITH
  leads AS (
    SELECT
      a.contact_id,
      a.occurred_at,
      CASE p_level
        WHEN 'ad'       THEN COALESCE(a.ad_id::TEXT, 'ext:' || a.ad_external_id, 'unknown')
        WHEN 'adset'    THEN COALESCE(a.ad_group_id::TEXT, 'unknown')
        WHEN 'campaign' THEN COALESCE(a.campaign_id::TEXT, 'unknown')
        ELSE a.platform
      END AS k
    FROM ad_attributed_leads(p_account_id, p_attribution) a
    WHERE a.occurred_at >= p_from::TIMESTAMPTZ
      AND a.occurred_at < (p_to + 1)::TIMESTAMPTZ
  ),
  -- A etapa mais avançada que cada contato já alcançou neste funil.
  -- Ganho conta como o fim do funil inteiro.
  progress AS (
    SELECT
      l.k,
      l.contact_id,
      MAX(
        CASE WHEN d.status = 'won' THEN 2147483647
             ELSE GREATEST(COALESCE(e.max_pos, -1), COALESCE(cur.position, -1))
        END
      ) AS max_pos
    FROM leads l
    JOIN deals d
      ON d.account_id = p_account_id
     AND d.contact_id = l.contact_id
     AND d.pipeline_id = p_pipeline_id
    LEFT JOIN pipeline_stages cur ON cur.id = d.stage_id
    LEFT JOIN LATERAL (
      SELECT MAX(ev.to_stage_position) AS max_pos
        FROM deal_stage_events ev
       WHERE ev.deal_id = d.id
    ) e ON TRUE
    GROUP BY l.k, l.contact_id
  ),
  stages AS (
    SELECT s.id, s.name, s.position
      FROM pipeline_stages s
     WHERE s.pipeline_id = p_pipeline_id
  )
  SELECT
    p.k::TEXT,
    st.id,
    st.name::TEXT,
    st.position,
    COUNT(DISTINCT p.contact_id) FILTER (WHERE p.max_pos >= st.position)::BIGINT
  FROM progress p
  CROSS JOIN stages st
  GROUP BY p.k, st.id, st.name, st.position
  ORDER BY p.k, st.position;
END;
$fn$;

GRANT EXECUTE ON FUNCTION ad_attributed_leads(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ad_performance(UUID, DATE, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ad_overview(UUID, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ad_daily_series(UUID, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ad_stage_funnel(UUID, DATE, DATE, UUID, TEXT, TEXT) TO authenticated;
