# Atribuição de anúncios

Liga cada lead do WhatsApp ao anúncio que o produziu, e cada negócio
ganho ao dinheiro que pagou por ele.

Sem isso o WhatsApp é um buraco negro de atribuição: o anúncio manda a
pessoa para uma conversa, e do outro lado chega um telefone sem nenhuma
pista de onde veio. Este módulo fecha essa lacuna por dois caminhos — um
para cada forma como o tráfego chega.

---

## O problema, em uma frase

Quando alguém sai de uma landing page e abre o WhatsApp, o navegador
descarta **tudo**: querystring, cookie, `localStorage` e `Referer`. Não
existe pixel, cookie de terceiro ou fingerprint que atravesse. A única
coisa que passa é o **texto da mensagem**.

O caminho da Meta é a exceção — e é por isso que os dois caminhos abaixo
são diferentes.

---

## Caminho 1 — Meta Click-to-WhatsApp (exato, sem configuração)

Anúncios CTWA não passam por landing page: o botão abre a conversa
direto. Nesse caso a **própria Meta** carimba um objeto `referral` na
primeira mensagem que a pessoa envia:

```jsonc
{
  "source_type": "ad",
  "source_id": "120210000000000000",  // id do ANÚNCIO
  "ctwa_clid": "ARBxyz…",             // id do clique
  "headline": "Frete grátis até sexta",
  "body": "…",
  "source_url": "https://fb.me/…"
}
```

O webhook (`src/app/api/whatsapp/webhook/route.ts`) lê isso e grava uma
linha em `attribution_touches`. Não precisa de nenhuma variável de
ambiente, nem de conta de anúncio conectada: **funciona sozinho a partir
da migration 040**.

Deduplicação: `ctwa_clid` tem índice único. A Meta reentrega o mesmo
webhook em retry, e sem essa trava cada retry viraria um lead novo — o
CPL despencaria sozinho e ninguém entenderia por quê.

## Caminho 2 — Google Ads (e Meta fora do CTWA): link carimbado

Aqui não existe `referral`. A ponte é montada assim:

```
anúncio  →  landing page  →  /api/track/<code>  →  wa.me com código no texto
```

1. Você cria um link em **Anúncios → Links rastreados**.
2. O botão de WhatsApp da LP aponta para `/api/track/<code>` em vez de
   apontar direto para o `wa.me`.
3. A rota grava o clique com `gclid` (ou `gbraid`/`wbraid` quando o
   consentimento derruba o gclid), `fbclid` e as UTMs, gera um token
   curto e único, e redireciona:

   ```
   https://wa.me/5511999999999?text=Olá!%20Vim%20pelo%20anúncio%0A%0A%5B%23K7QM2X%5D
   ```

4. Quando essa mensagem chega, o webhook lê `[#K7QM2X]` de volta e casa a
   conversa com aquele clique exato.

O token usa base32 de Crockford **sem I, L, O e U** — a pessoa às vezes
digita o código à mão, e `0/O` e `1/I/L` são o erro clássico. A leitura é
tolerante de propósito: casa com ou sem colchetes, em qualquer caixa e em
qualquer posição do texto, porque o WhatsApp deixa editar a mensagem
pré-preenchida antes de enviar.

### O que vai na landing page

Só trocar o `href` do botão de WhatsApp e colar um bloco. **Nenhum pixel,
nenhuma tag, nenhum SDK.**

```html
<a class="wa-track" href="https://SEU-APP/api/track/SEU-CODIGO">
  Falar no WhatsApp
</a>
```

O snippet pronto está em
[`snippet-landing-page.html`](./snippet-landing-page.html).

Ele existe por um motivo específico: o `gclid` e o `fbclid` chegam na URL
da **landing page**, não no link do botão. Um `href` fixo os deixa para
trás — o clique é registrado, mas sem saber de qual anúncio veio, e o
custo nunca casa com o lead.

Sem JavaScript o botão continua funcionando e o lead ainda é atribuído ao
LINK (portanto à campanha); o que se perde é o detalhe do criativo. Por
isso o `href` já vem completo no HTML e o script apenas enriquece.

### A métrica que só este caminho dá

**Clicou → chamou.** Quantos cliques no link viraram conversa. É a única
medida do vazamento entre a landing page e o WhatsApp — e é o que
distingue *anúncio ruim* (pouco clique) de *página ruim* (muito clique,
pouca conversa).

---

## Custo: as APIs oficiais

A atribuição funciona sem conectar nada. Conectar a conta de anúncio é o
que traz o **gasto**, e é o gasto que transforma contagem de leads em
CPL, CPA e ROAS.

| Plataforma | O que precisa | Onde |
|---|---|---|
| Meta | app com permissão `ads_read` | `META_ADS_APP_ID`, `META_ADS_APP_SECRET` |
| Google Ads | OAuth client **+ developer token** | `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` |

Redirect URIs a cadastrar:

```
<APP_URL>/api/ads/oauth/meta/callback
<APP_URL>/api/ads/oauth/google/callback
```

Duas pegadinhas que custam horas:

- **Google:** o developer token é uma credencial *separada* do OAuth,
  emitida no API Center da conta do Google Ads. Só OAuth devolve 403 em
  toda chamada.
- **Google:** a URL de autorização usa `access_type=offline` **e**
  `prompt=consent`. Sem o segundo, reconectar uma conta já autorizada
  devolve um access token de 1 hora e **nenhum refresh token** — e o
  sync para de funcionar sozinho na hora seguinte.

### Sincronização

Aponte um agendador de hora em hora para:

```
GET /api/ads/cron
x-cron-secret: <ADS_CRON_SECRET>
```

(cai para `AUTOMATION_CRON_SECRET` quando `ADS_CRON_SECRET` não existe,
então um agendador já configurado não precisa de segredo novo.)

Todo sync reprocessa os **últimos 7 dias**, não só hoje. Não é
desperdício: as duas plataformas reescrevem números já publicados por
dias — tráfego inválido devolvido, conversões atrasadas, ajuste de
faturamento. Um sync que só olhasse "hoje" congelaria o gasto de ontem
num valor que a própria plataforma já corrigiu, e o ROAS do mês nunca
fecharia com o gerenciador.

---

## A regra de data

Esta é a parte que mais confunde em painel de mídia. Três coisas
acontecem em dias diferentes e são contadas em dias diferentes, **de
propósito**:

| Métrica | Contada no dia… |
|---|---|
| Investimento | do faturamento da plataforma (`ad_insights_daily.date`) |
| Lead | em que a pessoa chamou (`attribution_touches.occurred_at`) |
| Receita | em que o negócio foi ganho (`deals.won_at`) |

Um negócio ganho hoje, de um lead que veio semana passada, entra na
**receita de hoje** e no **lead de semana passada**.

A alternativa — jogar a receita para o dia do clique — faria o ROAS de
meses já fechados mudar toda vez que alguém fechasse uma venda antiga.

**Consequência honesta:** em janelas curtas o ROAS aparece deprimido,
porque o ciclo de venda ainda não terminou. O painel avisa isso em texto,
sempre visível — não só quando o número está ruim.

`deals.won_at` é carimbado por trigger quando o status vira `won`, e
**limpo** quando o negócio é reaberto ou perdido. `updated_at` não
serviria: qualquer edição posterior empurraria a receita para outro dia.

---

## Modelo de atribuição

Primeiro clique (padrão) ou último clique, alternável no topo do painel.

Um contato pode ter vários toques — a mesma pessoa volta por outro
criativo. O modelo escolhe **um só**, senão a mesma venda seria contada
em dois criativos e o ROAS somaria acima de 100%. O desempate em caso de
empate de horário é pelo `id`, para o número não mudar entre dois
refreshes da mesma tela.

Não há modelagem estatística e não há janela de conversão adivinhada: se
a origem não é conhecida, o contato entra como **orgânico** e aparece
assim no painel, ao lado dos leads atribuídos.

---

## Esquema

Migration `040_ads_attribution.sql`:

| Tabela | Papel |
|---|---|
| `ad_accounts` | conta conectada; tokens cifrados com `ENCRYPTION_KEY` |
| `ad_campaigns` / `ad_groups` / `ads` | espelho da hierarquia da plataforma |
| `ad_insights_daily` | gasto por dia e por anúncio |
| `tracking_links` | os links carimbados |
| `ad_clicks` | cada passagem pelo redirect (gclid, UTMs, token) |
| `attribution_touches` | a ligação anúncio ↔ contato |

Migration `041_ads_metrics.sql` traz `ad_performance`, `ad_overview` e
`ad_daily_series` — a agregação roda no Postgres porque cada linha do
painel cruza quatro fontes de granularidades diferentes, e fazer isso no
navegador significaria baixar todos os toques e todos os negócios.

RLS: leitura para qualquer membro, escrita só para admin+. As três
funções são `SECURITY INVOKER` — o `p_account_id` é conveniência de
filtro, **não** a fronteira de segurança; quem isola é a policy.

### Desconectar não apaga histórico

Remover uma conta de anúncio derruba a hierarquia e o gasto (CASCADE),
mas os **toques sobrevivem**: `attribution_touches.ad_id` é
`ON DELETE SET NULL` e o `ad_external_id` cru permanece. O toque é um
fato histórico — aquela pessoa veio daquele anúncio, e isso não deixa de
ser verdade porque alguém desconectou a integração.

---

## Funil comercial: custo por etapa (migration 044)

O painel mede até o **lead qualificado** e cada etapa do funil, não só
lead e venda.

**Configurar (uma vez, em Funis → Gerenciar):**

1. Clique no selo da etapa que significa "lead qualificado". Chegar a ela
   **ou a qualquer etapa depois** carimba `deals.qualified_at`.
2. Ligue "Recebe leads do formulário" no funil comercial. Todo
   `POST /api/v1/leads` cria o negócio na primeira etapa dele (ou reusa o
   negócio aberto da mesma pessoa).

**O que fica gravado:**

- `deal_stage_events` — toda entrada em etapa e toda mudança de status,
  por trigger, com nome e posição da etapa no momento e quem mexeu.
  Imutável: não há policy de escrita.
- `deals.qualified_at` — nunca é apagado. Lead que qualificou e depois foi
  perdido custou como qualificado.
- Marcar a etapa com o funil já rodando preenche `qualified_at` dos
  negócios que já passaram dela (pela data do histórico).

**Regra de data dos qualificados:** coorte do lead. "Qualificados" e o
funil por etapa contam os leads que **chegaram no período** e olham tudo o
que aconteceu com eles até hoje. A receita segue pelo dia do ganho.

**No painel:** colunas Qualif., % qualif. e Custo/qualif.; nível "Por
conjunto"; e o **Funil por etapa** (`ad_stage_funnel`) — criativos nas
linhas, etapas nas colunas, com o custo por lead em cada etapa.

### Conversions API

Quando `qualified_at` ou `won_at` é carimbado, um trigger põe o evento em
`conversion_events` (um por conta Meta com a CAPI ligada; `event_id =
<deal>:<qualified|won>`, então reabrir e ganhar de novo não duplica). O
cron `/api/ads/cron` envia em lote, depois do sync.

- Nomes padrão **personalizados** (`LeadQualificado`, `VendaFechada`): a
  landing page já manda `Lead` e o checkout já manda `Purchase` no mesmo
  pixel.
- `action_source: system_generated`; e-mail, telefone e id do contato vão
  com SHA-256; `fbc` vem do cookie `_fbc` da página ou é montado do
  `fbclid`.
- Pula (status `skipped`, com o motivo): evento com mais de 7 dias (a Meta
  recusaria o lote), contato sem toque da Meta, nada para casar.
- O token é o mesmo da conta de anúncio; ele precisa de acesso ao pixel.
- Configuração em Anúncios → Contas de anúncio → API de Conversões. Com o
  código de teste preenchido, os eventos aparecem em "Testar eventos" e não
  entram na otimização.

### O que a landing page precisa mandar em `attribution`

`utm_*`, `fbclid`, `ad_id`, `adset_id`, `campaign_id`, `placement`
(parâmetros de URL do anúncio: `ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}&placement={{placement}}`)
e os cookies `fbc` (`_fbc`) e `fbp` (`_fbp`). `fbp` sozinho não conta como
origem de anúncio — o pixel grava em todo visitante.

---

## O que ainda não faz

- **Não devolve conversão para o Google.** A Meta recebe lead qualificado
  e venda pela Conversions API (acima); o Google Ads não.
- **Não converte moeda.** Se a conta de anúncio reporta em USD e os
  negócios estão em BRL, o painel mostra as duas moedas sem converter —
  melhor do que aplicar uma taxa inventada.
- **Não cobre outras plataformas** (TikTok, LinkedIn). O esquema é
  genérico o bastante (`platform` é uma coluna), mas os clientes de API
  não existem.

---

## Nota: `middleware.ts` continua sendo `middleware.ts`

O Next 16 marca `middleware` como depreciado e manda renomear para
`proxy` — inclusive com codemod oficial. **Não faça isso ainda no
16.2.12.**

O arquivo `src/proxy.ts` não é reconhecido. As constantes existem
(`PROXY_FILENAME`, `PROXY_LOCATION_REGEXP = (?:src/)?proxy`), mas nenhum
dos dois bundlers compila o arquivo — testado com Turbopack e com
`--webpack`. O codemod oficial aponta para `@next/codemod@canary`, o que
bate com a feature estar à frente do release estável.

O que torna isso perigoso é o silêncio. O build:

- termina com `✓ Compiled successfully`;
- imprime `ƒ Proxy (Middleware)` na legenda — que é **texto fixo**,
  impresso compile ou não;
- não emite nenhum aviso.

E o resultado é um app sem nenhum gating de autenticação: `/dashboard`,
`/ads`, `/settings` e todo o resto ficam publicamente acessíveis.

A única forma de verificar é olhar o manifesto:

```bash
node -e "console.log(Object.keys(require('./.next/server/middleware-manifest.json').middleware))"
# ['/']  → compilado
# []     → NÃO compilado
```

Vale repetir esse comando ao subir a versão do Next, antes de tentar a
renomeação de novo.
