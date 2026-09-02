import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  generateClickToken,
  buildPrefillText,
  buildWaMeUrl,
} from '@/lib/ads/click-token'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * A ponte entre a landing page e o WhatsApp.
 *
 * O botão "Falar no WhatsApp" da LP aponta para cá em vez de apontar
 * direto para o `wa.me`. Aqui o servidor faz duas coisas em ~30 ms e
 * devolve um 302:
 *
 *   1. grava o clique com tudo que o navegador ainda tem na mão —
 *      `gclid` (ou `gbraid`/`wbraid` quando o consentimento derruba o
 *      gclid), `fbclid`, as UTMs, a URL da página e o referrer;
 *   2. gera um token curto e único, embute no texto pré-preenchido e
 *      redireciona.
 *
 * Sem isso, a origem morre no pulo para o app: o WhatsApp não recebe
 * querystring, cookie nem `Referer`. O token no texto é literalmente o
 * único fio que atravessa.
 *
 * Rota PÚBLICA e anônima — é o destino de um anúncio. Por isso:
 *   - roda com a service role (não há sessão para a RLS avaliar), e cada
 *     escrita carrega o `account_id` resolvido a partir do link;
 *   - tem rate limit por IP, senão vira gerador de linhas grátis;
 *   - nunca devolve erro visível ao visitante. Se qualquer coisa falhar,
 *     ele ainda cai no WhatsApp — perder a atribuição de um clique é
 *     ruim, perder o LEAD é inaceitável.
 */

// Nada aqui é cacheável: cada visita precisa gerar um token novo.
export const dynamic = 'force-dynamic'

const CLICK_RATE_LIMIT = { limit: 60, windowMs: 60_000 }

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

/**
 * Para onde mandar quando não dá para resolver o link (code errado,
 * link desativado, banco fora do ar). Configurável porque o pior
 * resultado possível é o visitante que clicou num anúncio pago cair numa
 * página de erro.
 */
function fallbackDestination(): string {
  return (
    process.env.NEXT_PUBLIC_TRACK_FALLBACK_URL?.trim() ||
    // Mesma variável que o resto do projeto usa para a base pública.
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    'https://wa.me/'
  )
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params
  const code = rawCode?.toLowerCase().trim()

  try {
    const rl = checkRateLimit(`track:${getClientIp(request)}`, CLICK_RATE_LIMIT)
    if (!rl.success) {
      // Passou do limite: ainda redireciona (o visitante não tem culpa),
      // só não grava o clique.
      return NextResponse.redirect(fallbackDestination(), 302)
    }

    const db = supabaseAdmin()
    const { data: link } = await db
      .from('tracking_links')
      .select(
        'id, account_id, platform, destination_phone, prefill_text, is_active',
      )
      .eq('code', code)
      .maybeSingle()

    if (!link || !link.is_active) {
      return NextResponse.redirect(fallbackDestination(), 302)
    }

    const url = new URL(request.url)
    const q = (name: string) => url.searchParams.get(name)?.slice(0, 512) || null

    // Sem número de destino não há para onde mandar. Note que
    // `whatsapp_config.phone_number_id` NÃO serve de substituto: é um id
    // interno da Meta, não um telefone, e montar um `wa.me` com ele
    // abriria uma conversa com um contato inexistente. Por isso o número
    // é obrigatório na criação do link, e aqui só resta o fallback.
    const phone = link.destination_phone
    if (!phone) {
      console.error('[track] link sem telefone de destino:', code)
      return NextResponse.redirect(fallbackDestination(), 302)
    }

    // Colisão de token é praticamente impossível (32^6 ≈ 1 bilhão), mas o
    // índice único existe e uma colisão silenciosa reescreveria a origem
    // de outra pessoa. Três tentativas e seguimos.
    let clickToken: string | null = null
    for (let attempt = 0; attempt < 3 && !clickToken; attempt++) {
      const candidate = generateClickToken()
      const { error } = await db.from('ad_clicks').insert({
        account_id: link.account_id,
        tracking_link_id: link.id,
        click_token: candidate,
        platform: link.platform,
        gclid: q('gclid'),
        gbraid: q('gbraid'),
        wbraid: q('wbraid'),
        fbclid: q('fbclid'),
        utm_source: q('utm_source'),
        utm_medium: q('utm_medium'),
        utm_campaign: q('utm_campaign'),
        utm_content: q('utm_content'),
        utm_term: q('utm_term'),
        landing_url: q('lp') ?? request.headers.get('referer')?.slice(0, 1024) ?? null,
        referrer: request.headers.get('referer')?.slice(0, 1024) ?? null,
      })
      if (!error) clickToken = candidate
      else if (error.code !== '23505') {
        // Falha que não é colisão: não insiste. O visitante segue para o
        // WhatsApp sem carimbo — melhor um lead sem origem que nenhum.
        console.error('[track] falha ao gravar clique:', error)
        break
      }
    }

    // Sem token gravado, manda o texto humano puro.
    const text = clickToken
      ? buildPrefillText(link.prefill_text, clickToken)
      : (link.prefill_text ?? 'Olá! Vim pelo anúncio.')

    return NextResponse.redirect(buildWaMeUrl(phone, text), 302)
  } catch (err) {
    console.error('[track] erro inesperado:', err)
    return NextResponse.redirect(fallbackDestination(), 302)
  }
}
