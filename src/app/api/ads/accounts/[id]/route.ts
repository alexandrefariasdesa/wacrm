import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/** Nome de evento personalizado da Meta: letras, números e sublinhado. */
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/**
 * PATCH — configura a Conversions API da conta (admin+).
 *
 * Corpo: { capi_enabled?, capi_dataset_id?, capi_qualified_event?,
 *          capi_won_event?, capi_test_event_code? }
 *
 * Ligar exige o pixel preenchido: um interruptor ligado sem destino
 * enfileiraria eventos que só podem terminar como "pulado".
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const patch: Record<string, unknown> = {}
    if (typeof body.capi_dataset_id === 'string') {
      const dataset = body.capi_dataset_id.trim()
      if (dataset && !/^\d{5,20}$/.test(dataset)) {
        return NextResponse.json({ error: 'O id do pixel tem só números' }, { status: 400 })
      }
      patch.capi_dataset_id = dataset || null
    }
    for (const key of ['capi_qualified_event', 'capi_won_event'] as const) {
      if (typeof body[key] === 'string') {
        const name = (body[key] as string).trim()
        if (!EVENT_NAME.test(name)) {
          return NextResponse.json(
            { error: 'Nome de evento: comece com letra; só letras, números e _' },
            { status: 400 },
          )
        }
        patch[key] = name
      }
    }
    if (typeof body.capi_test_event_code === 'string') {
      patch.capi_test_event_code = body.capi_test_event_code.trim().slice(0, 40) || null
    }
    if (typeof body.capi_enabled === 'boolean') patch.capi_enabled = body.capi_enabled

    if (patch.capi_enabled === true) {
      const { data: current } = await supabase
        .from('ad_accounts')
        .select('platform, capi_dataset_id')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!current) {
        return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 })
      }
      if (current.platform !== 'meta') {
        return NextResponse.json({ error: 'Só contas da Meta' }, { status: 400 })
      }
      const dataset = 'capi_dataset_id' in patch ? patch.capi_dataset_id : current.capi_dataset_id
      if (!dataset) {
        return NextResponse.json({ error: 'Informe o id do pixel antes de ligar' }, { status: 400 })
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada para alterar' }, { status: 400 })
    }

    const { error } = await supabase
      .from('ad_accounts')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) {
      console.error('[ads accounts] falha ao configurar CAPI:', error)
      return NextResponse.json({ error: 'Falha ao salvar' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE — desconecta uma conta de anúncio.
 *
 * Apaga a linha, e com ela (por CASCADE) a hierarquia espelhada e o gasto
 * diário. Os TOQUES sobrevivem: `attribution_touches.ad_id` é
 * `ON DELETE SET NULL`, e `ad_external_id` fica.
 *
 * Isso é deliberado. O toque é um fato histórico — aquela pessoa VEIO
 * daquele anúncio, e isso não deixa de ser verdade porque alguém
 * desconectou a integração. Apagar junto reescreveria a origem de
 * contatos antigos e o painel do mês passado mudaria sozinho. O que se
 * perde é o custo (que volta se a conta for reconectada, pela janela de
 * lookback).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const { error } = await supabase
      .from('ad_accounts')
      .delete()
      .eq('id', id)
      // Redundante com a RLS, e mantido: uma policy afrouxada por engano
      // numa migration futura não deve virar "apago a conta de anúncio de
      // outro tenant conhecendo o uuid".
      .eq('account_id', accountId)

    if (error) {
      console.error('[ads accounts] falha ao desconectar:', error)
      return NextResponse.json(
        { error: 'Falha ao desconectar a conta' },
        { status: 500 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
