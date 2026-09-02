-- ============================================================
-- 041_ads_metrics.sql
--
-- As consultas do painel de anúncios, como funções SQL.
--
-- Por que no banco e não no TypeScript: cada linha do painel cruza QUATRO
-- fontes com granularidades diferentes (gasto por dia/anúncio, toque por
-- contato, conversa, negócio ganho). Fazer isso no cliente significaria
-- puxar todos os toques e todos os negócios para a memória do navegador —
-- é o mesmo erro do `.limit(10000)` que já derrubou métrica em outro
-- projeto. Aqui o Postgres agrega e devolve uma linha por anúncio.
--
-- ------------------------------------------------------------
-- A REGRA DE DATA (a parte que mais confunde em painel de mídia)
--
-- Três coisas acontecem em dias diferentes e são contadas em dias
-- diferentes, de propósito:
--
--   gasto   -> pelo DIA DA PLATAFORMA (ad_insights_daily.date)
--   lead    -> pelo dia do TOQUE (quando a pessoa chamou no WhatsApp)
--   receita -> pelo dia em que o negócio foi GANHO (deals.won_at)
--
-- Ou seja: um negócio ganho hoje, de um lead que veio semana passada,
-- entra na receita de HOJE e no lead de semana passada. É assim que
-- gerenciador de anúncios e CRM conversam sem mentir — o alternativo
-- (jogar a receita para o dia do clique) muda o ROAS de meses fechados
-- toda vez que alguém fecha uma venda antiga.
--
-- Consequência honesta: em janelas curtas o ROAS aparece deprimido,
-- porque o ciclo de venda ainda não terminou. A UI avisa isso.
-- ------------------------------------------------------------
-- ============================================================

-- ------------------------------------------------------------
-- ad_performance — uma linha por anúncio / campanha / plataforma
--
-- p_level:       'ad' | 'campaign' | 'platform'
-- p_attribution: 'first' (que anúncio TROUXE a pessoa — padrão)
--                'last'  (que anúncio a trouxe DE VOLTA por último)
--
-- Nota de implementação: a chave de agrupamento é TEXT e pode ser um
-- uuid ('<id do anúncio>'), um id cru da plataforma ainda não
-- sincronizado ('ext:120...') ou 'unknown'. Por isso os nomes legíveis
-- são resolvidos DENTRO de cada CTE de origem, onde as colunas uuid de
-- verdade existem, e nunca convertendo a chave de volta para uuid — um
-- `k::UUID` num JOIN estouraria em 'unknown', já que o Postgres não
-- garante curto-circuito de AND numa condição de junção.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ad_performance(
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
  IF p_level NOT IN ('ad', 'campaign', 'platform') THEN
    RAISE EXCEPTION 'nivel invalido: %', p_level;
  END IF;
  IF p_attribution NOT IN ('first', 'last') THEN
    RAISE EXCEPTION 'modelo de atribuicao invalido: %', p_attribution;
  END IF;

  RETURN QUERY
  WITH
  -- 1. O toque que "leva o crédito" por cada contato. Um contato pode ter
  --    vários toques; o modelo escolhe um só, senão a mesma venda seria
  --    contada em dois criativos e o ROAS somaria acima de 100%.
  ranked AS (
    SELECT
      t.id, t.contact_id, t.conversation_id, t.occurred_at,
      t.platform, t.ad_id, t.ad_external_id, t.campaign_id,
      ROW_NUMBER() OVER (
        PARTITION BY t.contact_id
        ORDER BY
          CASE WHEN p_attribution = 'last'
               THEN -EXTRACT(EPOCH FROM t.occurred_at)
               ELSE  EXTRACT(EPOCH FROM t.occurred_at)
          END ASC,
          -- Desempate estável: dois toques no mesmo instante (um retry
          -- que escapou do índice único) não podem alternar entre
          -- execuções, senão o número do painel muda sozinho no refresh.
          t.id ASC
      ) AS rn
    FROM attribution_touches t
    WHERE t.account_id = p_account_id
  ),
  attributed AS (
    SELECT
      r.contact_id,
      r.conversation_id,
      r.occurred_at,
      r.platform,
      r.ad_id,
      r.ad_external_id,
      -- A campanha pode vir do toque OU do anúncio espelhado. O toque do
      -- CTWA quase nunca traz campanha (a Meta só manda o id do anúncio),
      -- então a hierarquia sincronizada é quem completa.
      COALESCE(r.campaign_id, a.campaign_id) AS campaign_id,
      a.name          AS ad_name,
      a.status        AS ad_status,
      a.thumbnail_url AS ad_thumb,
      ac.name         AS ad_campaign_name,
      c.name          AS campaign_name,
      c.status        AS campaign_status,
      COALESCE(c.platform, a.platform, r.platform) AS resolved_platform
    FROM ranked r
    LEFT JOIN ads a           ON a.id = r.ad_id
    LEFT JOIN ad_campaigns ac ON ac.id = a.campaign_id
    LEFT JOIN ad_campaigns c  ON c.id = COALESCE(r.campaign_id, a.campaign_id)
    WHERE r.rn = 1
  ),

  -- 2. GASTO — pelo dia da plataforma.
  spend_rows AS (
    SELECT
      CASE p_level
        WHEN 'ad'       THEN COALESCE(i.ad_id::TEXT, 'ext:' || i.ad_external_id, 'unknown')
        WHEN 'campaign' THEN COALESCE(i.campaign_id::TEXT, 'unknown')
        ELSE i.platform
      END AS k,
      CASE p_level
        WHEN 'ad'       THEN a.name
        WHEN 'campaign' THEN c.name
        ELSE i.platform
      END AS lbl,
      CASE p_level
        WHEN 'ad'       THEN a.status
        WHEN 'campaign' THEN c.status
        ELSE NULL
      END AS st,
      CASE WHEN p_level = 'ad' THEN a.thumbnail_url ELSE NULL END AS thumb,
      CASE WHEN p_level = 'ad' THEN ac.name ELSE NULL END AS camp_lbl,
      i.platform AS plat,
      i.spend, i.impressions, i.clicks, i.currency
    FROM ad_insights_daily i
    LEFT JOIN ads a           ON a.id = i.ad_id
    LEFT JOIN ad_campaigns ac ON ac.id = a.campaign_id
    LEFT JOIN ad_campaigns c  ON c.id = i.campaign_id
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

  -- 3. LEADS / CONVERSAS — pelo dia do toque.
  lead_agg AS (
    SELECT
      CASE p_level
        WHEN 'ad'       THEN COALESCE(at.ad_id::TEXT, 'ext:' || at.ad_external_id, 'unknown')
        WHEN 'campaign' THEN COALESCE(at.campaign_id::TEXT, 'unknown')
        ELSE at.resolved_platform
      END AS k,
      MAX(CASE p_level
            WHEN 'ad'       THEN at.ad_name
            WHEN 'campaign' THEN at.campaign_name
            ELSE at.resolved_platform
          END) AS lbl,
      MAX(CASE p_level
            WHEN 'ad'       THEN at.ad_status
            WHEN 'campaign' THEN at.campaign_status
            ELSE NULL
          END) AS st,
      MAX(CASE WHEN p_level = 'ad' THEN at.ad_thumb ELSE NULL END) AS thumb,
      MAX(CASE WHEN p_level = 'ad' THEN at.ad_campaign_name ELSE NULL END) AS camp_lbl,
      MAX(at.resolved_platform) AS plat,
      COUNT(DISTINCT at.contact_id)::BIGINT      AS leads,
      COUNT(DISTINCT at.conversation_id)::BIGINT AS conversations
    FROM attributed at
    WHERE at.occurred_at >= p_from::TIMESTAMPTZ
      AND at.occurred_at < (p_to + 1)::TIMESTAMPTZ
    GROUP BY 1
  ),

  -- 4. RECEITA — pelo dia em que o negócio foi ganho. Sem filtro de data
  --    no toque: o lead pode ser antigo, e é exatamente isso que a gente
  --    quer enxergar (o criativo que ainda paga meses depois).
  deal_agg AS (
    SELECT
      CASE p_level
        WHEN 'ad'       THEN COALESCE(at.ad_id::TEXT, 'ext:' || at.ad_external_id, 'unknown')
        WHEN 'campaign' THEN COALESCE(at.campaign_id::TEXT, 'unknown')
        ELSE at.resolved_platform
      END AS k,
      COUNT(DISTINCT d.id)::BIGINT AS deals_won,
      SUM(d.value)                 AS revenue,
      MODE() WITHIN GROUP (ORDER BY d.currency) AS currency
    FROM deals d
    JOIN attributed at ON at.contact_id = d.contact_id
    WHERE d.account_id = p_account_id
      AND d.status = 'won'
      AND d.won_at IS NOT NULL
      AND d.won_at >= p_from::TIMESTAMPTZ
      AND d.won_at < (p_to + 1)::TIMESTAMPTZ
    GROUP BY 1
  ),

  -- 5. União das chaves. FULL OUTER na prática, porque as três pontas
  --    divergem de propósito: anúncio que gastou e não trouxe ninguém
  --    precisa aparecer (é o que se corta), e lead sem gasto casado
  --    também precisa aparecer (é sync faltando, não é lead grátis).
  keys AS (
    SELECT sa.k FROM spend_agg sa
    UNION
    SELECT la.k FROM lead_agg la
    UNION
    SELECT da.k FROM deal_agg da
  )
  SELECT
    kk.k AS group_key,
    -- Quando a hierarquia ainda não foi sincronizada, a chave 'ext:<id>'
    -- vira o próprio id — visível e diagnosticável, em vez de uma linha
    -- em branco que ninguém sabe interpretar.
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
-- ad_overview — os números do topo do painel
--
-- Inclui o que `ad_performance` deliberadamente não mostra: o volume que
-- NÃO veio de anúncio. Sem esse contraponto, o painel dá a impressão de
-- que a mídia paga responde por tudo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ad_overview(
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
  ranked AS (
    SELECT t.id, t.contact_id, t.occurred_at,
      ROW_NUMBER() OVER (
        PARTITION BY t.contact_id
        ORDER BY
          CASE WHEN p_attribution = 'last'
               THEN -EXTRACT(EPOCH FROM t.occurred_at)
               ELSE  EXTRACT(EPOCH FROM t.occurred_at)
          END ASC, t.id ASC
      ) AS rn
    FROM attribution_touches t
    WHERE t.account_id = p_account_id
  ),
  attributed AS (SELECT r.contact_id, r.occurred_at FROM ranked r WHERE r.rn = 1),
  s AS (
    SELECT COALESCE(SUM(i.spend), 0) AS spend,
           COALESCE(SUM(i.impressions), 0)::BIGINT AS impressions,
           COALESCE(SUM(i.clicks), 0)::BIGINT AS clicks
    FROM ad_insights_daily i
    WHERE i.account_id = p_account_id AND i.date >= p_from AND i.date <= p_to
  ),
  al AS (
    SELECT COUNT(DISTINCT a.contact_id)::BIGINT AS n
    FROM attributed a
    WHERE a.occurred_at >= p_from::TIMESTAMPTZ
      AND a.occurred_at < (p_to + 1)::TIMESTAMPTZ
  ),
  -- Orgânico = contato criado na janela que não tem NENHUM toque. Conta
  -- pelo created_at do contato porque é o único carimbo de "apareceu".
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
  -- Quantos clicaram no link da LP vs. quantos realmente mandaram
  -- mensagem. A diferença é o vazamento do pulo LP -> WhatsApp, e é a
  -- métrica que diz se vale mexer na página em vez de no anúncio.
  lc AS (
    SELECT COUNT(*)::BIGINT AS total,
           COUNT(*) FILTER (WHERE ac.matched_at IS NOT NULL)::BIGINT AS matched
    FROM ad_clicks ac
    WHERE ac.account_id = p_account_id
      AND ac.created_at >= p_from::TIMESTAMPTZ
      AND ac.created_at < (p_to + 1)::TIMESTAMPTZ
  )
  SELECT s.spend, s.impressions, s.clicks,
         al.n, ol.n, dg.deals_won, dg.revenue,
         lc.total, lc.matched
  FROM s, al, ol, dg, lc;
END;
$fn$;

-- ------------------------------------------------------------
-- ad_daily_series — a série do gráfico (gasto x leads x receita)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ad_daily_series(
  p_account_id UUID,
  p_from DATE,
  p_to DATE,
  p_attribution TEXT DEFAULT 'first'
)
RETURNS TABLE (
  day DATE,
  spend NUMERIC,
  leads BIGINT,
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
  ranked AS (
    SELECT t.id, t.contact_id, t.occurred_at,
      ROW_NUMBER() OVER (
        PARTITION BY t.contact_id
        ORDER BY
          CASE WHEN p_attribution = 'last'
               THEN -EXTRACT(EPOCH FROM t.occurred_at)
               ELSE  EXTRACT(EPOCH FROM t.occurred_at)
          END ASC, t.id ASC
      ) AS rn
    FROM attribution_touches t
    WHERE t.account_id = p_account_id
  ),
  attributed AS (SELECT r.contact_id, r.occurred_at FROM ranked r WHERE r.rn = 1),
  sp AS (
    SELECT i.date AS d, SUM(i.spend) AS amount
    FROM ad_insights_daily i
    WHERE i.account_id = p_account_id AND i.date >= p_from AND i.date <= p_to
    GROUP BY i.date
  ),
  ld AS (
    SELECT a.occurred_at::DATE AS d, COUNT(DISTINCT a.contact_id) AS n
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
         COALESCE(rv.amount, 0)
  FROM days
  LEFT JOIN sp ON sp.d = days.d
  LEFT JOIN ld ON ld.d = days.d
  LEFT JOIN rv ON rv.d = days.d
  ORDER BY days.d;
END;
$fn$;

-- As três são SECURITY INVOKER: rodam com os direitos de quem chama, e
-- portanto sob a RLS de quem chama. O `p_account_id` é conveniência de
-- filtro, NÃO a fronteira de segurança — passar o id de outra conta
-- devolve zero linhas porque as policies de 040/017 barram a leitura.
GRANT EXECUTE ON FUNCTION ad_performance(UUID, DATE, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ad_overview(UUID, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ad_daily_series(UUID, DATE, DATE, TEXT) TO authenticated;
