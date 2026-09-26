import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateCreateInput } from '@/lib/scheduled-messages/validate'

const LIST_COLUMNS = 'id, body, scheduled_for, status, attempts, last_error, sent_at'

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const raw = await request.json().catch(() => null)
    const parsed = validateCreateInput(raw, new Date())
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { conversationId, body, scheduledFor } = parsed.value

    // A conversa tem que ser desta conta (o trigger do banco também confere).
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const { data, error } = await supabase
      .from('scheduled_messages')
      .insert({
        account_id: accountId,
        conversation_id: conversationId,
        created_by: userId,
        body,
        scheduled_for: scheduledFor,
        status: 'pending',
      })
      .select('id')
      .single()
    if (error || !data) {
      console.error('[scheduled] insert falhou:', (error as { message?: string } | null)?.message)
      return NextResponse.json({ error: 'Não foi possível agendar' }, { status: 500 })
    }
    return NextResponse.json({ id: data.id }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// Pendentes/enviando + tudo o que estava marcado nas últimas 24 h.
export async function GET(request: Request) {
  try {
    const { supabase } = await requireRole('viewer')
    const conversationId = new URL(request.url).searchParams.get('conversation_id')
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id é obrigatório' }, { status: 400 })
    }
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data, error } = await supabase
      .from('scheduled_messages')
      .select(LIST_COLUMNS)
      .eq('conversation_id', conversationId)
      .or(`status.in.(pending,sending),scheduled_for.gte.${since}`)
      .order('scheduled_for', { ascending: true })
      .limit(50)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ items: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
