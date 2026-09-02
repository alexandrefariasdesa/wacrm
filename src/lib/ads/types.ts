/**
 * Tipos da camada de anúncios.
 *
 * Espelham as tabelas da migration 040 e o formato devolvido pelas
 * funções SQL da 041.
 */

export type AdPlatform = 'meta' | 'google'
/** `other` só existe em toque/link: é a origem marcada à mão. */
export type TouchPlatform = AdPlatform | 'other'

/** Como a origem de um contato foi descoberta. */
export type TouchSource = 'ctwa' | 'link_code' | 'manual'

/** Modelo de atribuição: qual toque leva o crédito da venda. */
export type AttributionModel = 'first' | 'last'

/** Nível de agrupamento do painel. */
export type AdLevel = 'ad' | 'campaign' | 'platform'

export interface AdAccount {
  id: string
  platform: AdPlatform
  external_id: string
  name: string
  currency: string
  timezone: string | null
  login_customer_id: string | null
  status: 'connected' | 'error' | 'disconnected'
  last_synced_at: string | null
  sync_error: string | null
  created_at: string
}

/**
 * O objeto `referral` que a Meta cola na primeira mensagem de quem veio
 * de um anúncio Click-to-WhatsApp.
 *
 * Todos os campos são opcionais na prática: a Meta varia o payload por
 * tipo de origem (anúncio vs. post orgânico) e por versão da API, e
 * campos somem sem aviso. O único que dá para tratar como espinha dorsal
 * é `source_id` (o id do anúncio) — e mesmo ele falta em post orgânico.
 */
export interface MetaReferral {
  /** URL do anúncio/post de origem. */
  source_url?: string
  /** `ad` para anúncio pago, `post` para post orgânico. */
  source_type?: string
  /** Id do ANÚNCIO na Meta (não da campanha). */
  source_id?: string
  /** Título do criativo, como o usuário viu. */
  headline?: string
  /** Corpo do criativo. */
  body?: string
  media_type?: string
  image_url?: string
  video_url?: string
  thumbnail_url?: string
  /**
   * Identificador do clique no CTWA. É o que a Meta pede de volta na
   * Conversions API para fechar o ciclo de otimização, e é o que serve
   * de chave de deduplicação contra retry do webhook.
   */
  ctwa_clid?: string
  /** Presente em anúncios de catálogo. */
  welcome_message?: unknown
}

export interface AdPerformanceRow {
  group_key: string
  label: string
  platform: string
  campaign_label: string | null
  status: string | null
  thumbnail_url: string | null
  spend: number
  impressions: number
  clicks: number
  leads: number
  conversations: number
  deals_won: number
  revenue: number
  spend_currency: string | null
  revenue_currency: string | null
}

export interface AdOverview {
  spend: number
  impressions: number
  clicks: number
  attributed_leads: number
  organic_leads: number
  deals_won: number
  revenue: number
  link_clicks: number
  link_clicks_matched: number
}

export interface AdDailyPoint {
  day: string
  spend: number
  leads: number
  revenue: number
}

export interface TrackingLink {
  id: string
  code: string
  name: string
  platform: TouchPlatform
  campaign_id: string | null
  ad_id: string | null
  destination_phone: string | null
  prefill_text: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  is_active: boolean
  created_at: string
}

/**
 * Métricas derivadas. Ficam fora do SQL de propósito: são divisões puras
 * e é mais fácil testá-las (e mostrar `null` em vez de Infinity) aqui.
 */
export interface DerivedMetrics {
  /** Custo por lead. `null` quando não houve lead. */
  cpl: number | null
  /** Custo por aquisição (negócio ganho). `null` quando não houve venda. */
  cpa: number | null
  /** Retorno sobre o investimento em anúncio. `null` quando não houve gasto. */
  roas: number | null
  /** Lead -> venda. `null` quando não houve lead. */
  conversionRate: number | null
  /** Ticket médio dos negócios ganhos. */
  averageTicket: number | null
}

/**
 * Divisões do painel, num lugar só.
 *
 * Cada uma devolve `null` — nunca `0`, nunca `Infinity` — quando o
 * denominador é zero. A diferença importa: um CPL `0` seria lido como
 * "lead de graça", quando a verdade é "não dá para calcular ainda". A UI
 * mostra "—" para `null`.
 */
export function deriveMetrics(row: {
  spend: number
  leads: number
  deals_won: number
  revenue: number
}): DerivedMetrics {
  return {
    cpl: row.leads > 0 ? row.spend / row.leads : null,
    cpa: row.deals_won > 0 ? row.spend / row.deals_won : null,
    roas: row.spend > 0 ? row.revenue / row.spend : null,
    conversionRate: row.leads > 0 ? row.deals_won / row.leads : null,
    averageTicket: row.deals_won > 0 ? row.revenue / row.deals_won : null,
  }
}
