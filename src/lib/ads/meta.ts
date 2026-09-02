/**
 * Cliente da Meta Marketing API — de onde vem o CUSTO do lado da Meta.
 *
 * A atribuição em si (quem veio de qual anúncio) não passa por aqui: ela
 * chega sozinha no webhook, via `referral`. O que falta é o outro lado da
 * conta — quanto cada anúncio custou — e isso só a API entrega.
 *
 * A versão fica alinhada com `lib/whatsapp/meta-api.ts` de propósito: as
 * duas falam com a mesma conta e o mesmo app, e versões divergentes
 * significam dois conjuntos de regras de depreciação para acompanhar.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export class MetaAdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Código de erro da Meta, quando vem. Útil para distinguir token
     *  expirado (190) de permissão faltando (200/294) e de throttling. */
    readonly code?: number,
  ) {
    super(message)
    this.name = 'MetaAdsError'
  }
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string }
}

/**
 * GET no Graph com paginação seguida até o fim.
 *
 * O `limit=500` não é otimização gratuita: uma conta com centenas de
 * anúncios ativos, no padrão de 25 por página, viraria dezenas de
 * round-trips por sync e bateria no rate limit da própria Meta.
 */
async function graphGetAll<T>(
  path: string,
  params: Record<string, string>,
  accessToken: string,
): Promise<T[]> {
  const out: T[] = []
  let url: string | null =
    `${META_API_BASE}/${path}?` +
    new URLSearchParams({ ...params, limit: '500', access_token: accessToken })

  // Teto de páginas. Sem ele, um cursor que não avança (já aconteceu na
  // Graph em janelas grandes) prenderia o sync num laço infinito e o
  // processo morreria por timeout, sem gravar nada.
  let pages = 0
  const MAX_PAGES = 50

  while (url && pages < MAX_PAGES) {
    pages++
    const res: Response = await fetch(url, { cache: 'no-store' })
    const json = (await res.json()) as { data?: T[]; paging?: { next?: string } } & GraphError

    if (!res.ok || json.error) {
      throw new MetaAdsError(
        json.error?.message ?? `Meta respondeu ${res.status}`,
        res.status,
        json.error?.code,
      )
    }

    if (json.data?.length) out.push(...json.data)
    url = json.paging?.next ?? null
  }

  return out
}

export interface MetaAdAccountSummary {
  id: string
  name: string
  currency: string
  timezone_name?: string
  account_status?: number
}

/** Contas de anúncio que o token consegue enxergar. */
export async function listMetaAdAccounts(
  accessToken: string,
): Promise<MetaAdAccountSummary[]> {
  return graphGetAll<MetaAdAccountSummary>(
    'me/adaccounts',
    { fields: 'id,name,currency,timezone_name,account_status' },
    accessToken,
  )
}

export interface MetaCampaign {
  id: string
  name: string
  status?: string
  objective?: string
}
export interface MetaAdSet {
  id: string
  name: string
  status?: string
  campaign_id?: string
}
export interface MetaAd {
  id: string
  name: string
  status?: string
  adset_id?: string
  campaign_id?: string
  creative?: { thumbnail_url?: string }
}

/**
 * A hierarquia campanha -> conjunto -> anúncio.
 *
 * Puxada inteira (não só o que teve gasto na janela) porque o webhook do
 * CTWA chega com o id de um anúncio que pode nunca ter aparecido num
 * insight — um anúncio que subiu hoje, gerou uma conversa e ainda não
 * fechou o primeiro dia de faturamento. Sem a hierarquia completa, esse
 * lead ficaria com o id cru no painel.
 */
export async function fetchMetaHierarchy(
  accessToken: string,
  adAccountExternalId: string,
): Promise<{ campaigns: MetaCampaign[]; adsets: MetaAdSet[]; ads: MetaAd[] }> {
  const act = adAccountExternalId.startsWith('act_')
    ? adAccountExternalId
    : `act_${adAccountExternalId}`

  const [campaigns, adsets, ads] = await Promise.all([
    graphGetAll<MetaCampaign>(
      `${act}/campaigns`,
      { fields: 'id,name,status,objective' },
      accessToken,
    ),
    graphGetAll<MetaAdSet>(
      `${act}/adsets`,
      { fields: 'id,name,status,campaign_id' },
      accessToken,
    ),
    graphGetAll<MetaAd>(
      `${act}/ads`,
      { fields: 'id,name,status,adset_id,campaign_id,creative{thumbnail_url}' },
      accessToken,
    ),
  ])

  return { campaigns, adsets, ads }
}

export interface MetaInsightRow {
  date_start: string
  date_stop: string
  ad_id?: string
  adset_id?: string
  campaign_id?: string
  spend?: string
  impressions?: string
  clicks?: string
}

/**
 * Gasto diário, no nível do anúncio.
 *
 * `time_increment: 1` é o que quebra o resultado em uma linha por dia —
 * sem ele a Meta devolve o período inteiro somado, e não haveria como
 * montar a série do gráfico nem recortar por sub-período depois.
 *
 * Os números vêm como STRING no JSON da Meta (é assim mesmo, inclusive
 * `spend`, para não perder precisão em float). A conversão fica no
 * chamador.
 */
export async function fetchMetaInsights(
  accessToken: string,
  adAccountExternalId: string,
  since: string,
  until: string,
): Promise<MetaInsightRow[]> {
  const act = adAccountExternalId.startsWith('act_')
    ? adAccountExternalId
    : `act_${adAccountExternalId}`

  return graphGetAll<MetaInsightRow>(
    `${act}/insights`,
    {
      level: 'ad',
      fields: 'ad_id,adset_id,campaign_id,spend,impressions,clicks',
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
    },
    accessToken,
  )
}

/**
 * Troca o token de curta duração (o que o SDK do browser devolve, ~1 h)
 * por um de longa duração (~60 dias).
 *
 * Sem esta troca a conexão morreria na primeira hora e o usuário teria de
 * reconectar a conta todo dia. A Meta não tem refresh token para este
 * fluxo: o caminho oficial é justamente reemitir o token longo antes de
 * ele vencer.
 */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const url =
    `${META_API_BASE}/oauth/access_token?` +
    new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    })

  const res = await fetch(url, { cache: 'no-store' })
  const json = (await res.json()) as {
    access_token?: string
    expires_in?: number
  } & GraphError

  if (!res.ok || json.error || !json.access_token) {
    throw new MetaAdsError(
      json.error?.message ?? `Falha ao trocar o token (${res.status})`,
      res.status,
      json.error?.code,
    )
  }

  return {
    accessToken: json.access_token,
    // A Meta omite `expires_in` quando o token não expira (raro, mas
    // acontece com token de System User). `null` significa "sem prazo",
    // e o sync não deve tratar isso como vencido.
    expiresInSeconds: json.expires_in ?? null,
  }
}

/** Troca o `code` do redirect OAuth pelo token de curta duração. */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string,
): Promise<string> {
  const url =
    `${META_API_BASE}/oauth/access_token?` +
    new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    })

  const res = await fetch(url, { cache: 'no-store' })
  const json = (await res.json()) as { access_token?: string } & GraphError

  if (!res.ok || json.error || !json.access_token) {
    throw new MetaAdsError(
      json.error?.message ?? `Falha no OAuth da Meta (${res.status})`,
      res.status,
      json.error?.code,
    )
  }
  return json.access_token
}

/** URL para onde mandar o usuário começar a conexão. */
export function metaOAuthUrl(
  appId: string,
  redirectUri: string,
  state: string,
): string {
  return (
    `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?` +
    new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      // `ads_read` basta: só lemos gasto e hierarquia. Pedir
      // `ads_management` aumentaria o escopo da revisão do app sem
      // necessidade — e dá ao token poder de ALTERAR campanhas, o que
      // este produto nunca faz.
      scope: 'ads_read',
      response_type: 'code',
    })
  )
}
