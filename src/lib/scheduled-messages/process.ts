import type { SupabaseClient } from '@supabase/supabase-js'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { CLAIM_BATCH, LATE_TOLERANCE_MS, MAX_ATTEMPTS, RETRY_DELAY_MS } from './constants'

interface DueRow {
  id: string
  account_id: string
  conversation_id: string
  body: string
  scheduled_for: string
  attempts: number
  claimed_at: string
}

export type Sender = (
  accountId: string,
  params: { conversationId: string; messageType: 'text'; contentText: string },
) => Promise<{ messageId: string }>

export interface ProcessResult {
  claimed: number
  sent: number
  failed: number
  missed: number
  retried: number
  /** perdeu a posse (outro worker recuperou a linha): não envia, o dono atual cuida */
  lost: number
}

export async function processDueMessages(
  db: SupabaseClient,
  send: Sender,
  clock: () => Date = () => new Date(),
): Promise<ProcessResult> {
  const { data, error } = await db.rpc('claim_due_scheduled_messages', { batch: CLAIM_BATCH })
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as DueRow[]
  const result: ProcessResult = { claimed: rows.length, sent: 0, failed: 0, missed: 0, retried: 0, lost: 0 }

  // Em série: o Evolution não gosta de rajada, e a ordem do agendamento é mantida.
  for (const row of rows) {
    const now = clock()
    const setStatus = async (patch: Record<string, unknown>) => {
      // .eq('status','sending') garante que só mexemos no que ainda é nosso.
      const { error: upErr } = await db
        .from('scheduled_messages')
        .update(patch)
        .eq('id', row.id)
        .eq('status', 'sending')
      if (upErr) console.error('[scheduled] update falhou', row.id, upErr.message)
    }

    if (now.getTime() - new Date(row.scheduled_for).getTime() > LATE_TOLERANCE_MS) {
      await setStatus({ status: 'missed', last_error: 'Perdeu o horário (atraso maior que 1 h)' })
      result.missed += 1
      continue
    }

    // Posse: o lote pode demorar mais que os 5 min da recuperação; se outro worker já reclamou
    // esta linha, `claimed_at` mudou e este UPDATE não acha nada — então NÃO enviamos (evita duplicar).
    const { data: owned } = await db
      .from('scheduled_messages')
      .update({ claimed_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'sending')
      .eq('claimed_at', row.claimed_at)
      .select('id')
    if (!owned?.length) {
      result.lost += 1
      continue
    }

    try {
      const sent = await send(row.account_id, {
        conversationId: row.conversation_id,
        messageType: 'text',
        contentText: row.body,
      })
      await setStatus({
        status: 'sent',
        message_id: sent.messageId,
        sent_at: now.toISOString(),
        last_error: null,
      })
      result.sent += 1
    } catch (err) {
      // db_error = o WhatsApp JÁ entregou e só a gravação local falhou: retentar duplicaria a mensagem.
      if (err instanceof SendMessageError && err.code === 'db_error') {
        await setStatus({
          status: 'sent',
          sent_at: now.toISOString(),
          last_error: 'Enviada, mas não foi gravada na conversa: ' + err.message,
        })
        result.sent += 1
        continue
      }
      const reason = err instanceof Error ? err.message : String(err)
      if (row.attempts < MAX_ATTEMPTS) {
        await setStatus({
          status: 'pending',
          last_error: reason,
          scheduled_for: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
        })
        result.retried += 1
      } else {
        await setStatus({ status: 'failed', last_error: reason })
        result.failed += 1
      }
    }
  }
  return result
}
