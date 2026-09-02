import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * PATCH  — liga/desliga o link, ou renomeia.
 * DELETE — remove.
 *
 * Desativar é quase sempre melhor que apagar: um link que já rodou em
 * anúncio continua sendo clicado por dias depois de a campanha parar (o
 * anúncio fica em cache, gente volta no histórico). Apagar faz esses
 * cliques caírem no fallback e a origem some; desativado, o visitante
 * também vai para o fallback, mas os cliques e leads já registrados
 * seguem no painel.
 */

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const body = (await request.json()) as {
      is_active?: boolean
      name?: string
      prefill_text?: string
    }

    const patch: Record<string, unknown> = {}
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
    if (body.name?.trim()) patch.name = body.name.trim()
    if (body.prefill_text !== undefined) {
      patch.prefill_text = body.prefill_text?.trim() || null
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada para atualizar' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('tracking_links')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, code, name, is_active, prefill_text')
      .single()

    if (error) {
      console.error('[ads links] falha ao atualizar:', error)
      return NextResponse.json({ error: 'Falha ao atualizar o link' }, { status: 500 })
    }

    return NextResponse.json({ link: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    // Os cliques sobrevivem: `ad_clicks.tracking_link_id` é
    // ON DELETE SET NULL, e os toques já casados guardam sua própria
    // cópia da origem. Apagar o link não reescreve o histórico.
    const { error } = await supabase
      .from('tracking_links')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)

    if (error) {
      console.error('[ads links] falha ao remover:', error)
      return NextResponse.json({ error: 'Falha ao remover o link' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
