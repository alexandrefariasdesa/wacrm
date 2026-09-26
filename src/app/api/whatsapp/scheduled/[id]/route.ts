import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const { supabase, accountId } = await requireRole('agent')
    // Só cancela o que ainda é pending; enviando/enviada não mudam.
    const { data, error } = await supabase
      .from('scheduled_messages')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data?.length) {
      return NextResponse.json({ error: 'Já foi enviada ou não está mais pendente' }, { status: 409 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
