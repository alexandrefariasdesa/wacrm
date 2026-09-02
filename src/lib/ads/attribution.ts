import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetaReferral } from './types'
import { extractClickToken } from './click-token'

/**
 * Registro dos toques de atribuição — o ponto em que "veio de anúncio"
 * deixa de ser uma suposição.
 *
 * Chamado de dentro do webhook do WhatsApp, com o cliente service-role
 * (a RLS de 040 só deixa admin escrever; o webhook não tem sessão).
 *
 * Regra geral destas funções: NUNCA derrubar o processamento da mensagem.
 * Atribuição é metadado. Se o INSERT falhar, a conversa ainda precisa
 * chegar na inbox — por isso tudo aqui devolve `null` e loga em vez de
 * propagar erro.
 */

/** Erro de violação de unicidade no Postgres. */
const UNIQUE_VIOLATION = '23505'

interface TouchContext {
  accountId: string
  contactId: string
  conversationId: string | null
  /** Hora da MENSAGEM, não do processamento. */
  occurredAt: Date
}

/**
 * Grava o toque de um anúncio Click-to-WhatsApp da Meta.
 *
 * O `referral` chega colado na primeira mensagem que a pessoa manda
 * depois de clicar no anúncio — e só nessa. Se a pessoa voltar dias
 * depois por outro anúncio, vem um `referral` novo, com outro
 * `ctwa_clid`: é um toque novo, e é isso que permite comparar primeiro
 * e último clique.
 *
 * Idempotente por `ctwa_clid`: a Meta reentrega o mesmo webhook em
 * retry, e sem essa trava cada retry viraria um lead novo — o CPL
 * despencaria sozinho e ninguém entenderia por quê.
 */
export async function recordCtwaTouch(
  db: SupabaseClient,
  ctx: TouchContext,
  referral: MetaReferral,
): Promise<string | null> {
  try {
    // Sem id do anúncio não há o que atribuir. Acontece em post orgânico
    // (`source_type: 'post'`), que não é mídia paga e não deve poluir o
    // CPL com um lead sem custo correspondente.
    const adExternalId = referral.source_id?.trim() || null
    if (!adExternalId && !referral.ctwa_clid) return null

    // Tenta ligar ao anúncio já espelhado. Falha silenciosa é esperada e
    // normal: o anúncio pode ter sido criado hoje e o sync ainda não ter
    // rodado. O `ad_external_id` cru fica gravado e o backfill religa
    // depois — por isso ele existe na tabela.
    let adId: string | null = null
    let campaignId: string | null = null
    if (adExternalId) {
      const { data: ad } = await db
        .from('ads')
        .select('id, campaign_id')
        .eq('account_id', ctx.accountId)
        .eq('external_id', adExternalId)
        .maybeSingle()
      if (ad) {
        adId = ad.id
        campaignId = ad.campaign_id
      }
    }

    const { data, error } = await db
      .from('attribution_touches')
      .insert({
        account_id: ctx.accountId,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        platform: 'meta',
        source: 'ctwa',
        ad_id: adId,
        campaign_id: campaignId,
        ad_external_id: adExternalId,
        ctwa_clid: referral.ctwa_clid ?? null,
        headline: referral.headline ?? null,
        body: referral.body ?? null,
        source_url: referral.source_url ?? null,
        media_url: referral.image_url ?? referral.video_url ?? referral.thumbnail_url ?? null,
        occurred_at: ctx.occurredAt.toISOString(),
      })
      .select('id')
      .single()

    if (error) {
      // Retry do webhook batendo no índice único de `ctwa_clid`: é o
      // comportamento correto, não um problema.
      if (error.code === UNIQUE_VIOLATION) return null
      console.error('[ads] falha ao gravar toque CTWA:', error)
      return null
    }

    return data?.id ?? null
  } catch (err) {
    console.error('[ads] erro inesperado no toque CTWA:', err)
    return null
  }
}

/**
 * Procura no texto da mensagem o código carimbado pela landing page e,
 * achando, liga a conversa ao clique exato que a originou.
 *
 * É o caminho do Google Ads (e de qualquer anúncio que passe por uma
 * página antes do WhatsApp). Diferente do CTWA, aqui a plataforma não
 * ajuda em nada — a ponte inteira é o token no texto.
 *
 * Só faz sentido na PRIMEIRA mensagem da conversa: o texto pré-preenchido
 * é o que a pessoa envia ao abrir o WhatsApp. Chamar em toda mensagem
 * gastaria uma consulta por mensagem recebida para achar quase sempre
 * nada, e ainda re-casaria um código que a pessoa colasse de novo.
 */
export async function recordLinkCodeTouch(
  db: SupabaseClient,
  ctx: TouchContext,
  messageText: string | null,
): Promise<string | null> {
  try {
    const token = extractClickToken(messageText)
    if (!token) return null

    const { data: click } = await db
      .from('ad_clicks')
      .select(
        'id, account_id, tracking_link_id, platform, gclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, matched_at',
      )
      .eq('click_token', token)
      .maybeSingle()

    if (!click) {
      // Token que não existe: alguém digitou errado, ou é de outro
      // ambiente. Não é erro — só não há o que atribuir.
      return null
    }

    // Um token vale para uma conta só. Sem esta checagem, um código
    // vazado de outra conta escreveria um toque no tenant errado — e a
    // service-role do webhook ignora RLS, então o banco não barraria.
    if (click.account_id !== ctx.accountId) {
      console.warn('[ads] token de clique de outra conta, ignorado:', token)
      return null
    }

    // Já casado: a pessoa reenviou a mesma mensagem, ou o webhook está em
    // retry. Um clique gera um toque só.
    if (click.matched_at) return null

    // Herda o vínculo com anúncio/campanha configurado no link.
    let adId: string | null = null
    let campaignId: string | null = null
    let platform: string = click.platform ?? 'google'
    if (click.tracking_link_id) {
      const { data: link } = await db
        .from('tracking_links')
        .select('ad_id, campaign_id, platform')
        .eq('id', click.tracking_link_id)
        .maybeSingle()
      if (link) {
        adId = link.ad_id
        campaignId = link.campaign_id
        platform = link.platform ?? platform
      }
    }

    const { data, error } = await db
      .from('attribution_touches')
      .insert({
        account_id: ctx.accountId,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        platform,
        source: 'link_code',
        ad_id: adId,
        campaign_id: campaignId,
        tracking_link_id: click.tracking_link_id,
        ad_click_id: click.id,
        gclid: click.gclid,
        utm_source: click.utm_source,
        utm_medium: click.utm_medium,
        utm_campaign: click.utm_campaign,
        utm_content: click.utm_content,
        utm_term: click.utm_term,
        occurred_at: ctx.occurredAt.toISOString(),
      })
      .select('id')
      .single()

    if (error) {
      if (error.code === UNIQUE_VIOLATION) return null
      console.error('[ads] falha ao gravar toque por link:', error)
      return null
    }

    // Fecha o clique. É o que separa "clicou e sumiu" de "clicou e
    // chamou" no painel — a métrica que diz se o gargalo é o anúncio ou
    // a landing page.
    await db
      .from('ad_clicks')
      .update({ matched_at: ctx.occurredAt.toISOString() })
      .eq('id', click.id)

    return data?.id ?? null
  } catch (err) {
    console.error('[ads] erro inesperado no toque por link:', err)
    return null
  }
}

/**
 * Religa toques órfãos ao anúncio correspondente.
 *
 * Existe porque a ordem natural é ao contrário do desejável: a pessoa
 * clica no anúncio novo minutos depois de ele subir, e o sync de
 * hierarquia só roda mais tarde. Esses toques ficam com `ad_external_id`
 * preenchido e `ad_id` nulo — visíveis no painel como uma linha crua com
 * o id da plataforma. Rodado ao fim de cada sync, isso some.
 */
export async function backfillTouchAdLinks(
  db: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { data: orphans } = await db
    .from('attribution_touches')
    .select('id, ad_external_id')
    .eq('account_id', accountId)
    .is('ad_id', null)
    .not('ad_external_id', 'is', null)
    .limit(1000)

  if (!orphans?.length) return 0

  const externalIds = [...new Set(orphans.map((o) => o.ad_external_id as string))]
  const { data: ads } = await db
    .from('ads')
    .select('id, external_id, campaign_id')
    .eq('account_id', accountId)
    .in('external_id', externalIds)

  if (!ads?.length) return 0

  const byExternal = new Map(ads.map((a) => [a.external_id as string, a]))
  let fixed = 0

  for (const orphan of orphans) {
    const ad = byExternal.get(orphan.ad_external_id as string)
    if (!ad) continue
    const { error } = await db
      .from('attribution_touches')
      .update({ ad_id: ad.id, campaign_id: ad.campaign_id })
      .eq('id', orphan.id)
    if (!error) fixed++
  }

  return fixed
}
