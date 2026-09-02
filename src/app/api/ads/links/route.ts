import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { isValidLinkCode } from '@/lib/ads/click-token'
import { isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * Links rastreáveis — o caminho de atribuição para Google Ads e para
 * qualquer anúncio que passe por uma landing page antes do WhatsApp.
 *
 * GET  — lista (qualquer membro).
 * POST — cria (admin+).
 */

export const dynamic = 'force-dynamic'

const COLUMNS =
  'id, code, name, platform, campaign_id, ad_id, destination_phone, prefill_text, utm_source, utm_medium, utm_campaign, utm_content, utm_term, is_active, created_at'

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('tracking_links')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[ads links] falha ao listar:', error)
      return NextResponse.json({ error: 'Falha ao listar links' }, { status: 500 })
    }

    // Contagem de cliques e de casamentos por link. Feita em UMA consulta
    // agregada e não com um `count` por link: uma conta com 50 links
    // faria 100 round-trips para montar uma tabela.
    const { data: clicks } = await supabase
      .from('ad_clicks')
      .select('tracking_link_id, matched_at')
      .eq('account_id', accountId)
      .limit(50_000)

    const stats = new Map<string, { clicks: number; matched: number }>()
    for (const c of clicks ?? []) {
      const key = c.tracking_link_id as string | null
      if (!key) continue
      const entry = stats.get(key) ?? { clicks: 0, matched: 0 }
      entry.clicks++
      if (c.matched_at) entry.matched++
      stats.set(key, entry)
    }

    return NextResponse.json({
      links: (data ?? []).map((l) => ({
        ...l,
        clicks: stats.get(l.id as string)?.clicks ?? 0,
        matched: stats.get(l.id as string)?.matched ?? 0,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateBody {
  code?: string
  name?: string
  platform?: 'meta' | 'google' | 'other'
  destination_phone?: string
  prefill_text?: string
  campaign_id?: string | null
  ad_id?: string | null
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  utm_term?: string
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = (await request.json()) as CreateBody

    const code = body.code?.trim().toLowerCase() ?? ''
    if (!isValidLinkCode(code)) {
      return NextResponse.json(
        {
          error:
            'Código inválido. Use de 2 a 31 caracteres: letras minúsculas, números, hífen ou sublinhado, começando por letra ou número.',
        },
        { status: 400 },
      )
    }
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Dê um nome ao link' }, { status: 400 })
    }

    // O telefone é obrigatório: sem ele a rota de redirect não tem para
    // onde mandar o visitante, e o link viraria um anúncio pago apontando
    // para uma página de erro.
    const phone = body.destination_phone?.replace(/\D/g, '') ?? ''
    if (!phone || !isValidE164(`+${phone}`)) {
      return NextResponse.json(
        { error: 'Informe o número de destino no formato internacional (ex.: 5511999999999)' },
        { status: 400 },
      )
    }

    const platform = body.platform ?? 'google'
    if (!['meta', 'google', 'other'].includes(platform)) {
      return NextResponse.json({ error: 'Plataforma inválida' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('tracking_links')
      .insert({
        account_id: accountId,
        user_id: userId,
        code,
        name: body.name.trim(),
        platform,
        destination_phone: phone,
        prefill_text: body.prefill_text?.trim() || null,
        campaign_id: body.campaign_id || null,
        ad_id: body.ad_id || null,
        utm_source: body.utm_source?.trim() || null,
        utm_medium: body.utm_medium?.trim() || null,
        utm_campaign: body.utm_campaign?.trim() || null,
        utm_content: body.utm_content?.trim() || null,
        utm_term: body.utm_term?.trim() || null,
      })
      .select(COLUMNS)
      .single()

    if (error) {
      // O code é único GLOBALMENTE (a rota pública resolve por ele sem
      // saber a conta), então a colisão pode ser com o link de outro
      // tenant. A mensagem não pode confirmar isso — seria um oráculo
      // para descobrir os códigos de terceiros.
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'Esse código já está em uso. Escolha outro.' },
          { status: 409 },
        )
      }
      console.error('[ads links] falha ao criar:', error)
      return NextResponse.json({ error: 'Falha ao criar o link' }, { status: 500 })
    }

    return NextResponse.json({ link: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
