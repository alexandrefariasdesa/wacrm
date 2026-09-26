import { after, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  SendMessageError,
  sendMessageToConversation,
} from '@/lib/whatsapp/send-message'
import { defaultSleep, sendSteps } from '@/lib/quick-replies/run-steps'
import { stepToSendParams, validateSteps, type SequenceStep } from '@/lib/quick-replies/steps'

// Um clique na lateral da caixa de entrada. O 1º passo sai DENTRO da requisição (o erro volta
// para a tela na hora); os demais rodam em after(), na ordem, respeitando a espera de cada um.
export const maxDuration = 300

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`qrsend:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id é obrigatório' }, { status: 400 })
    }

    const { data: qr } = await supabase
      .from('quick_replies')
      .select('id, kind, content_text, steps')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!qr) return NextResponse.json({ error: 'Mensagem rápida não encontrada' }, { status: 404 })

    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    let steps: SequenceStep[]
    if (qr.kind === 'interactive') {
      return NextResponse.json(
        { error: 'Mensagens com botões são enviadas pelo campo de mensagem' },
        { status: 400 },
      )
    } else if (qr.kind === 'sequence') {
      const parsed = validateSteps(qr.steps)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422 })
      steps = parsed.steps
    } else {
      const text = typeof qr.content_text === 'string' ? qr.content_text.trim() : ''
      if (!text) return NextResponse.json({ error: 'Mensagem rápida vazia' }, { status: 422 })
      steps = [{ type: 'text', text, delay_seconds: 0 }]
    }

    const admin = supabaseAdmin()
    const send = (step: SequenceStep) =>
      sendMessageToConversation(admin, accountId, { conversationId, ...stepToSendParams(step) })

    // 1º passo, síncrono: qualquer erro (canal caído, sem telefone…) volta ao usuário.
    const [first, ...rest] = steps
    if (first.delay_seconds > 0) await defaultSleep(first.delay_seconds * 1000)
    try {
      await send(first)
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    if (rest.length > 0) {
      after(async () => {
        const result = await sendSteps(rest, send)
        if (result.failed) {
          // Sem retentativa: repetir duplicaria o que já saiu. A conversa mostra até onde foi.
          console.error(
            `[quick-reply-send] ${id} parou no passo ${result.failed.index + 2} de ${steps.length}: ${result.failed.error}`,
          )
        }
      })
    }

    return NextResponse.json({ steps: steps.length }, { status: 202 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
