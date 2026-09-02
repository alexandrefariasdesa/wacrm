-- ============================================================
-- 040_ads_attribution.sql
--
-- Camada de ANÚNCIOS: liga cada conversa do WhatsApp ao anúncio que
-- a gerou, e cada negócio ganho de volta ao investimento que o pagou.
--
-- Dois caminhos de atribuição, porque as duas plataformas se comportam
-- de forma diferente:
--
--   1. Meta / Click-to-WhatsApp (exato, sem pixel)
--      A própria Meta carimba um objeto `referral` na PRIMEIRA mensagem
--      de quem veio de um anúncio CTWA — com `source_id` (id do anúncio),
--      `ctwa_clid`, headline e o criativo. O webhook até hoje jogava isso
--      fora. Agora vira uma linha em `attribution_touches`.
--
--   2. Google Ads (e Meta fora do CTWA): anúncio -> landing page -> wa.me
--      Não existe `referral` nesse caminho: o pulo do navegador pro
--      WhatsApp descarta querystring, cookie e Referer — a origem morre
--      ali. A única coisa que atravessa é o TEXTO da mensagem. Então a
--      LP manda o visitante pra /api/track/<code>, que registra o clique
--      (com gclid/gbraid/wbraid/utm) e devolve um redirect pro wa.me com
--      um código curto e único embutido no texto pré-preenchido. Quando
--      essa mensagem chega, o webhook lê o código e casa a conversa com
--      aquele clique exato.
--
-- Custo vem das APIs oficiais (Meta Marketing API / Google Ads API) para
-- `ad_insights_daily`. Receita vem de `deals.status = 'won'`, atribuída
-- ao PRIMEIRO toque do contato.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- 0. deals.won_at — quando o negócio virou receita
--
-- `updated_at` não serve: qualquer edição posterior (uma nota, uma
-- mudança de título) empurraria a receita para outro dia e o ROAS do
-- período mudaria sozinho. Precisamos do instante em que o status
-- passou a 'won', congelado.
-- ------------------------------------------------------------
ALTER TABLE deals ADD COLUMN IF NOT EXISTS won_at TIMESTAMPTZ;

-- Backfill conservador: negócios já ganhos passam a valer pela última
-- atualização conhecida. Não é exato para o histórico, mas é o único
-- dado que existe, e daqui pra frente o trigger cuida.
UPDATE deals SET won_at = COALESCE(updated_at, created_at)
  WHERE status = 'won' AND won_at IS NULL;

CREATE OR REPLACE FUNCTION stamp_deal_won_at()
RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.status = 'won' AND (OLD.status IS DISTINCT FROM 'won') THEN
    NEW.won_at = NOW();
  ELSIF NEW.status <> 'won' THEN
    -- Negócio reaberto ou perdido deixa de ser receita: limpa o carimbo
    -- para não continuar somando no ROAS.
    NEW.won_at = NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stamp_won_at ON deals;
CREATE TRIGGER stamp_won_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION stamp_deal_won_at();

-- INSERT direto já como 'won' (importação, criação manual de fechado)
CREATE OR REPLACE FUNCTION stamp_deal_won_at_insert()
RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.status = 'won' AND NEW.won_at IS NULL THEN
    NEW.won_at = NOW();
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stamp_won_at_insert ON deals;
CREATE TRIGGER stamp_won_at_insert BEFORE INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION stamp_deal_won_at_insert();

CREATE INDEX IF NOT EXISTS idx_deals_won_at ON deals(account_id, won_at)
  WHERE status = 'won';

-- ------------------------------------------------------------
-- 1. ad_accounts — a conta de anúncio conectada
--
-- Os tokens ficam cifrados com a MESMA chave (ENCRYPTION_KEY) e o mesmo
-- helper de `whatsapp_config.access_token` / `ai_configs.api_key`; a
-- coluna guarda ciphertext, nunca o token puro.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Quem conectou. Auditoria apenas — nunca usado para isolamento.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'google')),
  -- Meta: `act_123456`. Google: o customer id sem hífens (`1234567890`).
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Moeda em que a plataforma reporta o gasto. Pode diferir da moeda dos
  -- negócios; a UI mostra as duas e não converte às cegas.
  currency TEXT NOT NULL DEFAULT 'BRL',
  -- Fuso horário da conta de anúncio. A Meta reporta o dia no fuso DELA;
  -- guardar isso evita "sumiço" de gasto na virada do dia.
  timezone TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  -- Google Ads: a MCC/conta gestora que autoriza o acesso, quando houver.
  login_customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'error', 'disconnected')),
  last_synced_at TIMESTAMPTZ,
  -- Última falha de sync, legível. NULL quando o último sync deu certo.
  sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_accounts_account ON ad_accounts(account_id);

-- ------------------------------------------------------------
-- 2. Hierarquia: campanha -> conjunto/grupo -> anúncio
--
-- Espelho local do que existe na plataforma. Serve para nomear as linhas
-- do painel (o insight diário só traz ids) e para agrupar por campanha
-- sem depender de um join contra a API a cada request.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'google')),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT,
  objective TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ad_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_account ON ad_campaigns(account_id);

CREATE TABLE IF NOT EXISTS ad_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'google')),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ad_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_groups_account ON ad_groups(account_id);
CREATE INDEX IF NOT EXISTS idx_ad_groups_campaign ON ad_groups(campaign_id);

CREATE TABLE IF NOT EXISTS ads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  ad_group_id UUID REFERENCES ad_groups(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'google')),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT,
  -- Miniatura do criativo, quando a plataforma expõe. Só para a UI.
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ad_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ads_account ON ads(account_id);
CREATE INDEX IF NOT EXISTS idx_ads_campaign ON ads(campaign_id);
-- O webhook do CTWA chega com o id do anúncio da Meta e precisa achar a
-- linha local por esse id, sem saber de qual conta de anúncio ele veio.
CREATE INDEX IF NOT EXISTS idx_ads_external ON ads(account_id, external_id);

-- ------------------------------------------------------------
-- 3. ad_insights_daily — o gasto, dia a dia, no nível do anúncio
--
-- Uma linha por (conta de anúncio, dia, anúncio). O nível de anúncio é
-- o mais fino que as duas APIs entregam de forma confiável e é onde a
-- decisão de criativo acontece; campanha e conjunto saem por SUM.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_insights_daily (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'google')),
  -- DATE, não timestamp: é o dia de faturamento no fuso da conta de
  -- anúncio, que é como a plataforma fecha a conta.
  date DATE NOT NULL,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  ad_group_id UUID REFERENCES ad_groups(id) ON DELETE CASCADE,
  ad_id UUID REFERENCES ads(id) ON DELETE CASCADE,
  -- Guardados crus também: um insight pode chegar antes de a hierarquia
  -- ter sido sincronizada, e sem isso a linha ficaria órfã e invisível.
  ad_external_id TEXT,
  spend NUMERIC(14, 4) NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ad_account_id, date, ad_external_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_insights_account_date
  ON ad_insights_daily(account_id, date);
CREATE INDEX IF NOT EXISTS idx_ad_insights_ad ON ad_insights_daily(ad_id);

-- ------------------------------------------------------------
-- 4. tracking_links — o link carimbado (caminho Google/LP)
--
-- Um link por criativo (ou por LP). O botão de WhatsApp da landing page
-- aponta para /api/track/<code>; o resto acontece no redirect.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Slug curto e público que vive na URL. Case-insensitive na prática:
  -- a aplicação normaliza para minúsculas antes de gravar/consultar.
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'google'
    CHECK (platform IN ('meta', 'google', 'other')),
  -- Vínculo opcional com o anúncio/campanha espelhados. Quando presente,
  -- o gasto daquele anúncio encontra os leads deste link.
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  ad_id UUID REFERENCES ads(id) ON DELETE SET NULL,
  -- Telefone de destino (E.164, sem '+'). NULL usa o número conectado.
  destination_phone TEXT,
  -- Texto que o WhatsApp abre já digitado. O código do clique é anexado
  -- pela rota de redirect; este campo é só a parte humana.
  prefill_text TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, code)
);
-- A rota pública resolve o link só pelo code, sem saber a conta ainda,
-- então o code precisa ser único globalmente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_links_code ON tracking_links(code);

-- ------------------------------------------------------------
-- 5. ad_clicks — cada passagem pela rota de redirect
--
-- É o que sobra do lado do navegador: gclid, gbraid/wbraid, fbclid e as
-- UTMs, mais o `click_token` que vai embutido no texto da mensagem e é o
-- único fio que sobrevive até o WhatsApp.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tracking_link_id UUID REFERENCES tracking_links(id) ON DELETE SET NULL,
  -- Token curto, único, que aparece no texto pré-preenchido. Case-
  -- insensitive por convenção da aplicação (sempre maiúsculo).
  click_token TEXT NOT NULL UNIQUE,
  platform TEXT,
  gclid TEXT,
  -- Substitutos do gclid quando o consentimento/iOS bloqueia o original.
  gbraid TEXT,
  wbraid TEXT,
  fbclid TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  landing_url TEXT,
  referrer TEXT,
  -- Preenchido quando a mensagem correspondente chega no webhook. Um
  -- clique sem `matched_at` é alguém que clicou e não mandou mensagem —
  -- exatamente a perda que o painel precisa mostrar.
  matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_account_created
  ON ad_clicks(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_link ON ad_clicks(tracking_link_id);

-- ------------------------------------------------------------
-- 6. attribution_touches — a ligação anúncio <-> contato
--
-- Uma linha por vez que um contato chegou por um anúncio. Guardamos
-- TODOS os toques (não só o primeiro) porque a mesma pessoa pode voltar
-- por outro criativo, e a diferença entre primeiro e último toque é
-- justamente o que a análise de criativo quer enxergar.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attribution_touches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'google', 'other')),
  -- Como a origem foi descoberta:
  --   ctwa       -> objeto `referral` da própria Meta (exato)
  --   link_code  -> código carimbado no texto da 1a mensagem (LP -> wa.me)
  --   manual     -> alguém marcou a mão no CRM
  source TEXT NOT NULL CHECK (source IN ('ctwa', 'link_code', 'manual')),
  ad_id UUID REFERENCES ads(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  tracking_link_id UUID REFERENCES tracking_links(id) ON DELETE SET NULL,
  ad_click_id UUID REFERENCES ad_clicks(id) ON DELETE SET NULL,
  -- Ids crus da plataforma. Preservados mesmo quando ainda não existe
  -- linha local em `ads` — a hierarquia pode ser sincronizada depois e
  -- o backfill religa pelo external_id.
  ad_external_id TEXT,
  campaign_external_id TEXT,
  -- Identificador de clique do CTWA. É o que a Meta pede de volta na
  -- Conversions API para fechar o ciclo de otimização.
  ctwa_clid TEXT,
  -- O que o usuário viu antes de clicar, direto do payload da Meta.
  headline TEXT,
  body TEXT,
  source_url TEXT,
  media_url TEXT,
  gclid TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  -- Quando o toque aconteceu (hora da mensagem, não do INSERT).
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_touches_account_occurred
  ON attribution_touches(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_touches_contact
  ON attribution_touches(contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_touches_ad ON attribution_touches(ad_id);

-- A Meta reentrega o mesmo webhook em retry, e o `referral` vem colado
-- na mesma mensagem. Sem isso, cada retry viraria um lead novo e o CPL
-- despencaria sozinho. `ctwa_clid` é único por clique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_touches_ctwa_clid
  ON attribution_touches(ctwa_clid) WHERE ctwa_clid IS NOT NULL;
-- Mesma proteção no caminho do link: um clique gera no máximo um toque.
CREATE UNIQUE INDEX IF NOT EXISTS idx_touches_click
  ON attribution_touches(ad_click_id) WHERE ad_click_id IS NOT NULL;

-- ------------------------------------------------------------
-- 7. RLS — mesmo modelo de tenancy do resto (017)
--
-- Leitura para qualquer membro; escrita reservada a admin+. São dados de
-- investimento: um agente vê o painel, mas não conecta conta de anúncio.
-- (O webhook e o sync escrevem com a service role, que ignora RLS.)
-- ------------------------------------------------------------
ALTER TABLE ad_accounts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_campaigns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_groups           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_insights_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_links      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_clicks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_touches ENABLE ROW LEVEL SECURITY;

DO $rls$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'ad_accounts', 'ad_campaigns', 'ad_groups', 'ads',
    'ad_insights_daily', 'tracking_links', 'ad_clicks',
    'attribution_touches'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (is_account_member(account_id))',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (is_account_member(account_id, ''admin''))',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (is_account_member(account_id, ''admin''))',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (is_account_member(account_id, ''admin''))',
      t || '_delete', t);
  END LOOP;
END
$rls$;

-- ------------------------------------------------------------
-- 8. updated_at
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON ad_accounts;
DROP TRIGGER IF EXISTS set_updated_at ON ad_campaigns;
DROP TRIGGER IF EXISTS set_updated_at ON ad_groups;
DROP TRIGGER IF EXISTS set_updated_at ON ads;
DROP TRIGGER IF EXISTS set_updated_at ON tracking_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ad_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ad_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tracking_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
