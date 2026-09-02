import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  fetchMetaHierarchy,
  fetchMetaInsights,
  MetaAdsError,
} from './meta'
import {
  fetchGoogleHierarchy,
  fetchGoogleInsights,
  refreshGoogleAccessToken,
  GoogleAdsError,
} from './google'
import { backfillTouchAdLinks } from './attribution'
import type { AdPlatform } from './types'

/**
 * O sincronizador: traz hierarquia e gasto das plataformas para o banco.
 *
 * Roda pelo cron (de hora em hora) e pelo botão "Sincronizar agora".
 *
 * ------------------------------------------------------------
 * A JANELA DESLIZANTE
 *
 * Todo sync reprocessa os últimos N dias, não só o dia de hoje. Isso não
 * é desperdício: as duas plataformas REESCREVEM números já publicados
 * por dias — tráfego inválido devolvido, conversões atrasadas, ajuste de
 * faturamento. Um sync que só olhasse "hoje" congelaria o gasto de ontem
 * num valor que a própria plataforma já corrigiu, e o ROAS do mês nunca
 * fecharia com o gerenciador.
 *
 * Sete dias cobre a janela de correção das duas com folga.
 * ------------------------------------------------------------
 */
const DEFAULT_LOOKBACK_DAYS = 7

export interface SyncResult {
  adAccountId: string
  platform: AdPlatform
  campaigns: number
  adGroups: number
  ads: number
  insightRows: number
  touchesRelinked: number
  error?: string
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Sincroniza UMA conta de anúncio.
 *
 * Nunca lança: o erro vira `sync_error` na linha da conta e volta no
 * resultado. Uma conta com token expirado não pode derrubar o sync das
 * outras — e o usuário precisa ver *qual* conta quebrou, na UI, em vez de
 * um 500 genérico.
 */
export async function syncAdAccount(
  db: SupabaseClient,
  adAccount: {
    id: string
    account_id: string
    platform: AdPlatform
    external_id: string
    access_token: string | null
    refresh_token: string | null
    login_customer_id: string | null
  },
  opts: { lookbackDays?: number } = {},
): Promise<SyncResult> {
  const lookback = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const until = new Date()
  const since = new Date(until.getTime() - lookback * 24 * 60 * 60 * 1000)

  const result: SyncResult = {
    adAccountId: adAccount.id,
    platform: adAccount.platform,
    campaigns: 0,
    adGroups: 0,
    ads: 0,
    insightRows: 0,
    touchesRelinked: 0,
  }

  try {
    if (adAccount.platform === 'meta') {
      await syncMeta(db, adAccount, ymd(since), ymd(until), result)
    } else {
      await syncGoogle(db, adAccount, ymd(since), ymd(until), result)
    }

    // Toques que chegaram antes de o anúncio existir localmente. Rodado
    // aqui, no fim, porque é exatamente agora que a hierarquia acabou de
    // ficar completa.
    result.touchesRelinked = await backfillTouchAdLinks(db, adAccount.account_id)

    await db
      .from('ad_accounts')
      .update({
        last_synced_at: new Date().toISOString(),
        sync_error: null,
        status: 'connected',
      })
      .eq('id', adAccount.id)
  } catch (err) {
    const message =
      err instanceof MetaAdsError || err instanceof GoogleAdsError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Erro desconhecido'

    result.error = message
    console.error(`[ads sync] conta ${adAccount.id} falhou:`, message)

    await db
      .from('ad_accounts')
      .update({
        sync_error: message.slice(0, 500),
        status: 'error',
        // `last_synced_at` NÃO é atualizado numa falha, de propósito: ele
        // é o "quando os números foram confiáveis pela última vez", e a
        // UI usa a distância dele para avisar que o painel está velho.
      })
      .eq('id', adAccount.id)
  }

  return result
}

async function syncMeta(
  db: SupabaseClient,
  adAccount: { id: string; account_id: string; external_id: string; access_token: string | null },
  since: string,
  until: string,
  result: SyncResult,
) {
  if (!adAccount.access_token) throw new Error('Conta sem token de acesso')
  const token = decrypt(adAccount.access_token)

  const { campaigns, adsets, ads } = await fetchMetaHierarchy(
    token,
    adAccount.external_id,
  )

  // ---- campanhas
  if (campaigns.length) {
    const { error } = await db.from('ad_campaigns').upsert(
      campaigns.map((c) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        platform: 'meta',
        external_id: c.id,
        name: c.name,
        status: c.status ?? null,
        objective: c.objective ?? null,
      })),
      { onConflict: 'ad_account_id,external_id' },
    )
    if (error) throw new Error(`Falha ao gravar campanhas: ${error.message}`)
    result.campaigns = campaigns.length
  }

  const campaignIdMap = await idMap(db, 'ad_campaigns', adAccount.id)

  // ---- conjuntos
  if (adsets.length) {
    const { error } = await db.from('ad_groups').upsert(
      adsets.map((s) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        campaign_id: s.campaign_id ? (campaignIdMap.get(s.campaign_id) ?? null) : null,
        platform: 'meta',
        external_id: s.id,
        name: s.name,
        status: s.status ?? null,
      })),
      { onConflict: 'ad_account_id,external_id' },
    )
    if (error) throw new Error(`Falha ao gravar conjuntos: ${error.message}`)
    result.adGroups = adsets.length
  }

  const groupIdMap = await idMap(db, 'ad_groups', adAccount.id)

  // ---- anúncios
  if (ads.length) {
    const { error } = await db.from('ads').upsert(
      ads.map((a) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        campaign_id: a.campaign_id ? (campaignIdMap.get(a.campaign_id) ?? null) : null,
        ad_group_id: a.adset_id ? (groupIdMap.get(a.adset_id) ?? null) : null,
        platform: 'meta',
        external_id: a.id,
        name: a.name,
        status: a.status ?? null,
        thumbnail_url: a.creative?.thumbnail_url ?? null,
      })),
      { onConflict: 'ad_account_id,external_id' },
    )
    if (error) throw new Error(`Falha ao gravar anúncios: ${error.message}`)
    result.ads = ads.length
  }

  const adIdMap = await idMap(db, 'ads', adAccount.id)

  // ---- gasto diário
  const insights = await fetchMetaInsights(token, adAccount.external_id, since, until)
  if (insights.length) {
    const { data: acct } = await db
      .from('ad_accounts')
      .select('currency')
      .eq('id', adAccount.id)
      .maybeSingle()

    const rows = insights
      .filter((i) => i.ad_id)
      .map((i) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        platform: 'meta',
        date: i.date_start,
        campaign_id: i.campaign_id ? (campaignIdMap.get(i.campaign_id) ?? null) : null,
        ad_group_id: i.adset_id ? (groupIdMap.get(i.adset_id) ?? null) : null,
        ad_id: adIdMap.get(i.ad_id!) ?? null,
        ad_external_id: i.ad_id!,
        spend: Number(i.spend ?? 0),
        impressions: Number(i.impressions ?? 0),
        clicks: Number(i.clicks ?? 0),
        currency: acct?.currency ?? 'BRL',
        synced_at: new Date().toISOString(),
      }))

    await upsertInsights(db, rows)
    result.insightRows = rows.length
  }
}

async function syncGoogle(
  db: SupabaseClient,
  adAccount: {
    id: string
    account_id: string
    external_id: string
    refresh_token: string | null
    login_customer_id: string | null
  },
  since: string,
  until: string,
  result: SyncResult,
) {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET

  if (!developerToken || !clientId || !clientSecret) {
    throw new Error(
      'Google Ads não configurado no servidor (GOOGLE_ADS_DEVELOPER_TOKEN / CLIENT_ID / CLIENT_SECRET)',
    )
  }
  if (!adAccount.refresh_token) {
    throw new Error('Conta sem refresh token — reconecte a conta do Google Ads')
  }

  const { accessToken, expiresInSeconds } = await refreshGoogleAccessToken(
    decrypt(adAccount.refresh_token),
    clientId,
    clientSecret,
  )

  // Guarda o access token renovado. Não é estritamente necessário (o
  // próximo sync renova de novo), mas deixa a conexão inspecionável e
  // evita uma renovação a mais quando alguém aperta "sincronizar agora"
  // logo depois do cron.
  await db
    .from('ad_accounts')
    .update({
      access_token: encrypt(accessToken),
      token_expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    })
    .eq('id', adAccount.id)

  const opts = {
    accessToken,
    developerToken,
    customerId: adAccount.external_id,
    loginCustomerId: adAccount.login_customer_id,
  }

  const hierarchy = await fetchGoogleHierarchy(opts)

  // O GAQL devolve a hierarquia desnormalizada — uma linha por anúncio,
  // repetindo campanha e grupo. Desduplicar antes do upsert evita mandar
  // a mesma campanha centenas de vezes no mesmo payload, o que faria o
  // PostgREST rejeitar o lote inteiro ("ON CONFLICT DO UPDATE command
  // cannot affect row a second time").
  const campaigns = new Map(
    hierarchy.map((r) => [
      r.campaignId,
      { id: r.campaignId, name: r.campaignName, status: r.campaignStatus },
    ]),
  )
  const groups = new Map(
    hierarchy.map((r) => [
      r.adGroupId,
      { id: r.adGroupId, name: r.adGroupName, campaignId: r.campaignId },
    ]),
  )
  const adsByExternal = new Map(
    hierarchy.map((r) => [
      r.adId,
      { id: r.adId, name: r.adName, status: r.adStatus, adGroupId: r.adGroupId, campaignId: r.campaignId },
    ]),
  )

  if (campaigns.size) {
    const { error } = await db.from('ad_campaigns').upsert(
      [...campaigns.values()].map((c) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        platform: 'google',
        external_id: c.id,
        name: c.name,
        status: c.status,
      })),
      { onConflict: 'ad_account_id,external_id' },
    )
    if (error) throw new Error(`Falha ao gravar campanhas: ${error.message}`)
    result.campaigns = campaigns.size
  }

  const campaignIdMap = await idMap(db, 'ad_campaigns', adAccount.id)

  if (groups.size) {
    const { error } = await db.from('ad_groups').upsert(
      [...groups.values()].map((g) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        campaign_id: campaignIdMap.get(g.campaignId) ?? null,
        platform: 'google',
        external_id: g.id,
        name: g.name,
      })),
      { onConflict: 'ad_account_id,external_id' },
    )
    if (error) throw new Error(`Falha ao gravar grupos: ${error.message}`)
    result.adGroups = groups.size
  }

  const groupIdMap = await idMap(db, 'ad_groups', adAccount.id)

  if (adsByExternal.size) {
    const { error } = await db.from('ads').upsert(
      [...adsByExternal.values()].map((a) => ({
        account_id: adAccount.account_id,
        ad_account_id: adAccount.id,
        campaign_id: campaignIdMap.get(a.campaignId) ?? null,
        ad_group_id: groupIdMap.get(a.adGroupId) ?? null,
        platform: 'google',
        external_id: a.id,
        name: a.name,
        status: a.status,
      })),
      { onConflict: 'ad_account_id,external_id' },
    )
    if (error) throw new Error(`Falha ao gravar anúncios: ${error.message}`)
    result.ads = adsByExternal.size
  }

  const adIdMap = await idMap(db, 'ads', adAccount.id)

  const insights = await fetchGoogleInsights(opts, since, until)
  if (insights.length) {
    const { data: acct } = await db
      .from('ad_accounts')
      .select('currency')
      .eq('id', adAccount.id)
      .maybeSingle()

    const rows = insights.map((i) => ({
      account_id: adAccount.account_id,
      ad_account_id: adAccount.id,
      platform: 'google',
      date: i.date,
      campaign_id: campaignIdMap.get(i.campaignId) ?? null,
      ad_group_id: groupIdMap.get(i.adGroupId) ?? null,
      ad_id: adIdMap.get(i.adId) ?? null,
      ad_external_id: i.adId,
      spend: i.spend,
      impressions: i.impressions,
      clicks: i.clicks,
      currency: acct?.currency ?? 'BRL',
      synced_at: new Date().toISOString(),
    }))

    await upsertInsights(db, rows)
    result.insightRows = rows.length
  }
}

/**
 * Mapa `external_id -> id interno` de uma tabela da hierarquia.
 *
 * Relido depois de cada upsert porque o Supabase não devolve os ids do
 * lote de forma confiável quando há conflito (a linha atualizada pode não
 * voltar no `select()`), e um id errado aqui espalharia gasto para o
 * anúncio errado.
 */
async function idMap(
  db: SupabaseClient,
  table: 'ad_campaigns' | 'ad_groups' | 'ads',
  adAccountId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select('id, external_id')
      .eq('ad_account_id', adAccountId)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Falha ao ler ${table}: ${error.message}`)
    if (!data?.length) break
    for (const row of data) map.set(row.external_id as string, row.id as string)
    if (data.length < PAGE) break
  }
  return map
}

/**
 * Grava os insights em lotes.
 *
 * 500 por vez: uma conta ativa com 200 anúncios e 7 dias de janela passa
 * de mil linhas, e um único payload desse tamanho estoura o limite de
 * corpo do PostgREST.
 */
async function upsertInsights(
  db: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<void> {
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db
      .from('ad_insights_daily')
      .upsert(rows.slice(i, i + BATCH), {
        onConflict: 'ad_account_id,date,ad_external_id',
      })
    if (error) throw new Error(`Falha ao gravar gasto diário: ${error.message}`)
  }
}

/** Sincroniza todas as contas conectadas de um tenant (ou de todos). */
export async function syncAllAdAccounts(
  db: SupabaseClient,
  opts: { accountId?: string; lookbackDays?: number } = {},
): Promise<SyncResult[]> {
  let query = db
    .from('ad_accounts')
    .select(
      'id, account_id, platform, external_id, access_token, refresh_token, login_customer_id',
    )
    .neq('status', 'disconnected')

  if (opts.accountId) query = query.eq('account_id', opts.accountId)

  const { data: accounts, error } = await query
  if (error) throw new Error(`Falha ao listar contas de anúncio: ${error.message}`)
  if (!accounts?.length) return []

  const results: SyncResult[] = []
  // Sequencial: as duas APIs têm cota por app (não por conta), e disparar
  // tudo em paralelo é a forma mais rápida de tomar throttling e ficar
  // sem NENHUMA conta sincronizada.
  for (const acct of accounts) {
    results.push(
      await syncAdAccount(db, acct as Parameters<typeof syncAdAccount>[1], {
        lookbackDays: opts.lookbackDays,
      }),
    )
  }
  return results
}
