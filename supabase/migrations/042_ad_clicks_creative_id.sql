-- ============================================================
-- 042_ad_clicks_creative_id.sql
--
-- Atribuição no nível do CRIATIVO para o caminho da landing page.
--
-- O problema que isto corrige
-- ---------------------------
-- Até aqui, um toque vindo de link rastreado herdava o anúncio do que
-- estava configurado no PRÓPRIO LINK (`tracking_links.ad_id`) — uma
-- associação estática, definida na criação.
--
-- Isso funciona para quem cria um link por criativo. Não funciona para o
-- caso normal: uma landing page, um link, e uma campanha com dez
-- criativos apontando para ela. Nessa configuração o gasto chega da API
-- separado por anúncio, mas TODOS os leads caem numa linha só — e o CPL
-- por criativo, que é a decisão que o painel existe para informar, fica
-- impossível de calcular.
--
-- A solução usa o que as duas plataformas já oferecem: parâmetro
-- dinâmico na URL de destino. A Meta substitui `{{ad.id}}` e o Google
-- substitui `{creative}` pelo id real do anúncio no momento do clique.
-- A landing page repassa esse valor ao link de rastreio, e aqui ele
-- vira a ligação com o anúncio de verdade.
--
-- Guardamos o id CRU (external), não a FK: o clique costuma acontecer
-- antes de o sync espelhar o anúncio, e uma FK obrigaria a descartar a
-- informação exatamente no caso mais comum (criativo novo, que é
-- justamente o que se quer medir). `backfillTouchAdLinks` religa depois.
-- ============================================================

ALTER TABLE ad_clicks
  ADD COLUMN IF NOT EXISTS ad_external_id TEXT,
  ADD COLUMN IF NOT EXISTS campaign_external_id TEXT;

-- Consultado no casamento do toque, para achar o anúncio local a partir
-- do id da plataforma.
CREATE INDEX IF NOT EXISTS idx_ad_clicks_ad_external
  ON ad_clicks(account_id, ad_external_id)
  WHERE ad_external_id IS NOT NULL;
