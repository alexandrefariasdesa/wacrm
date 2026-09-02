import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

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
