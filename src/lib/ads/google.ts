/**
 * Cliente da Google Ads API — o custo do lado do Google.
 *
 * Três diferenças em relação à Meta que moldam este arquivo:
 *
 *   1. Não existe CTWA no Google. Todo lead passa por uma landing page,
 *      e a origem chega pelo token carimbado no texto (ver
 *      `click-token.ts`). Aqui só buscamos gasto.
 *
 *   2. A API exige um `developer-token` do app ALÉM do OAuth do usuário.
 *      É uma credencial da aplicação, não da conta — mora no ambiente.
 *
 *   3. O token OAuth do Google expira em 1 hora, mas vem com refresh
 *      token de verdade (a Meta não tem). Então renovamos a cada sync em
 *      vez de guardar um token longo.
 *
 * Usamos a REST API com GAQL em vez do SDK oficial: a biblioteca Node do
 * Google Ads é gRPC + protobuf, pesa mais de 100 MB instalada e não
 * sobrevive bem a um build de container. Duas chamadas HTTP resolvem.
 */

const GOOGLE_ADS_API_VERSION = 'v18'
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export class GoogleAdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GoogleAdsError'
  }
}

/**
 * Renova o access token a partir do refresh token.
 *
 * Chamado no começo de cada sync, sem checar validade: o token dura 1 h,
 * o sync roda de hora em hora, e uma chamada a mais é bem mais barata que
 * a lógica de expiração com relógios fora de sincronia entre servidores.
 */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: 'no-store',
  })

  const json = (await res.json()) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !json.access_token) {
    throw new GoogleAdsError(
      json.error_description ?? json.error ?? `Falha ao renovar token (${res.status})`,
      res.status,
    )
  }

  return { accessToken: json.access_token, expiresInSeconds: json.expires_in ?? 3600 }
}

interface SearchOptions {
  accessToken: string
  developerToken: string
  customerId: string
  /** A MCC/conta gestora, quando o acesso vem por ela. */
  loginCustomerId?: string | null
}

/**
 * Executa uma consulta GAQL e devolve todas as linhas.
 *
 * `searchStream` (e não `search`) porque ele não pagina: devolve o
 * resultado inteiro como um array de blocos, e uma conta grande com
 * 90 dias de histórico passa fácil das dezenas de milhares de linhas que
 * o `search` obrigaria a paginar uma a uma.
 */
async function gaqlSearch<T>(query: string, opts: SearchOptions): Promise<T[]> {
  // A API rejeita o customer id com hífen — e o formato que a interface
  // do Google Ads mostra tem hífen. Normalizar aqui evita um erro
  // absolutamente opaco ("customer not found") no primeiro sync.
  const customerId = opts.customerId.replace(/\D/g, '')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    'developer-token': opts.developerToken,
    'Content-Type': 'application/json',
  }
  if (opts.loginCustomerId) {
    headers['login-customer-id'] = opts.loginCustomerId.replace(/\D/g, '')
  }

  const res = await fetch(
    `${GOOGLE_ADS_BASE}/customers/${customerId}/googleAds:searchStream`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
      cache: 'no-store',
    },
  )

  const text = await res.text()
  if (!res.ok) {
    // O erro do Google Ads vem aninhado fundo e o texto útil costuma
    // estar em `error.details[].errors[].message`. Preferimos o corpo
    // cru truncado a uma extração frágil que engoliria a causa real.
    throw new GoogleAdsError(
      `Google Ads respondeu ${res.status}: ${text.slice(0, 500)}`,
      res.status,
    )
  }

  // searchStream devolve um ARRAY de objetos `{ results: [...] }`, não um
  // objeto único — tratar como objeto é o erro clássico de integração.
  const chunks = JSON.parse(text) as Array<{ results?: T[] }>
  return chunks.flatMap((c) => c.results ?? [])
}

export interface GoogleAdsCustomer {
  id: string
  descriptiveName: string
  currencyCode: string
  timeZone: string
  manager: boolean
}

/** Contas acessíveis pelo token, com nome e moeda. */
export async function listGoogleAdsAccounts(
  accessToken: string,
  developerToken: string,
): Promise<GoogleAdsCustomer[]> {
  // `listAccessibleCustomers` devolve só resource names ("customers/123"),
  // sem nome nem moeda — não dá para montar um seletor legível com isso.
  const res = await fetch(`${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': developerToken,
    },
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new GoogleAdsError(
      `Falha ao listar contas do Google Ads (${res.status}): ${(await res.text()).slice(0, 300)}`,
      res.status,
    )
  }

  const json = (await res.json()) as { resourceNames?: string[] }
  const ids = (json.resourceNames ?? []).map((rn) => rn.split('/')[1])

  // Segunda passada: uma consulta por conta para pegar nome/moeda/fuso.
  // Sequencial de propósito — a API tem cota por minuto e uma rajada
  // paralela sobre uma MCC com dezenas de contas dispara throttling.
  const out: GoogleAdsCustomer[] = []
  for (const id of ids) {
    try {
      const rows = await gaqlSearch<{
        customer: {
          id: string
          descriptiveName?: string
          currencyCode?: string
          timeZone?: string
          manager?: boolean
        }
      }>(
        `SELECT customer.id, customer.descriptive_name, customer.currency_code,
                customer.time_zone, customer.manager
         FROM customer LIMIT 1`,
        { accessToken, developerToken, customerId: id },
      )
      const c = rows[0]?.customer
      if (c) {
        out.push({
          id: c.id,
          descriptiveName: c.descriptiveName ?? c.id,
          currencyCode: c.currencyCode ?? 'BRL',
          timeZone: c.timeZone ?? 'America/Sao_Paulo',
          manager: c.manager ?? false,
        })
      }
    } catch {
      // Conta sem permissão de leitura na listagem: aparece em
      // `listAccessibleCustomers` mas nega o SELECT. Pular é o certo —
      // uma delas não pode derrubar a listagem inteira.
    }
  }

  return out
}

export interface GoogleAdRow {
  campaignId: string
  campaignName: string
  campaignStatus: string
  adGroupId: string
  adGroupName: string
  adId: string
  adName: string
  adStatus: string
}

/** Hierarquia campanha -> grupo de anúncios -> anúncio. */
export async function fetchGoogleHierarchy(
  opts: SearchOptions,
): Promise<GoogleAdRow[]> {
  const rows = await gaqlSearch<{
    campaign: { id: string; name: string; status: string }
    adGroup: { id: string; name: string }
    adGroupAd: { ad: { id: string; name?: string }; status: string }
  }>(
    `SELECT campaign.id, campaign.name, campaign.status,
            ad_group.id, ad_group.name,
            ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status
     FROM ad_group_ad
     WHERE ad_group_ad.status != 'REMOVED'`,
    opts,
  )

  return rows.map((r) => ({
    campaignId: r.campaign.id,
    campaignName: r.campaign.name,
    campaignStatus: r.campaign.status,
    adGroupId: r.adGroup.id,
    adGroupName: r.adGroup.name,
    adId: r.adGroupAd.ad.id,
    // Anúncio responsivo de pesquisa quase nunca tem `name` preenchido —
    // o Google mostra os títulos no lugar. Sem este fallback a tabela
    // ficaria com uma coluna inteira em branco.
    adName: r.adGroupAd.ad.name || `Anúncio ${r.adGroupAd.ad.id}`,
    adStatus: r.adGroupAd.status,
  }))
}

export interface GoogleInsightRow {
  date: string
  campaignId: string
  adGroupId: string
  adId: string
  /** Já convertido de micros para a moeda da conta. */
  spend: number
  impressions: number
  clicks: number
}

/**
 * Gasto diário no nível do anúncio.
 *
 * `metrics.cost_micros` vem em MILIONÉSIMOS da moeda da conta — 1 500 000
 * é R$ 1,50. Dividir por 1e6 aqui, no ponto de entrada, evita que a
 * unidade errada vaze para o banco e apareça como um CPL mil vezes maior.
 */
export async function fetchGoogleInsights(
  opts: SearchOptions,
  since: string,
  until: string,
): Promise<GoogleInsightRow[]> {
  const rows = await gaqlSearch<{
    segments: { date: string }
    campaign: { id: string }
    adGroup: { id: string }
    adGroupAd: { ad: { id: string } }
    metrics: { costMicros?: string; impressions?: string; clicks?: string }
  }>(
    `SELECT segments.date, campaign.id, ad_group.id, ad_group_ad.ad.id,
            metrics.cost_micros, metrics.impressions, metrics.clicks
     FROM ad_group_ad
     WHERE segments.date BETWEEN '${since}' AND '${until}'`,
    opts,
  )

  return rows.map((r) => ({
    date: r.segments.date,
    campaignId: r.campaign.id,
    adGroupId: r.adGroup.id,
    adId: r.adGroupAd.ad.id,
    spend: Number(r.metrics.costMicros ?? 0) / 1_000_000,
    impressions: Number(r.metrics.impressions ?? 0),
    clicks: Number(r.metrics.clicks ?? 0),
  }))
}

/** Troca o `code` do OAuth pelo par access/refresh. */
export async function exchangeGoogleCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string | null; expiresInSeconds: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    cache: 'no-store',
  })

  const json = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  }

  if (!res.ok || !json.access_token) {
    throw new GoogleAdsError(
      json.error_description ?? json.error ?? `Falha no OAuth do Google (${res.status})`,
      res.status,
    )
  }

  return {
    accessToken: json.access_token,
    // Só vem na PRIMEIRA autorização. Reconectar uma conta já autorizada
    // devolve `undefined` aqui — por isso o `prompt=consent` na URL de
    // autorização, que força o Google a reemitir.
    refreshToken: json.refresh_token ?? null,
    expiresInSeconds: json.expires_in ?? 3600,
  }
}

/** URL de autorização. */
export function googleOAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return (
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      // Os dois juntos são o que garante refresh token: `offline` pede,
      // `consent` força reemitir mesmo para quem já autorizou antes. Sem
      // `consent`, reconectar devolve um access token de 1 h e nenhum
      // refresh — e o sync para de funcionar sozinho na hora seguinte.
      access_type: 'offline',
      prompt: 'consent',
      state,
    })
  )
}
