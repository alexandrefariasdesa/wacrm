import { BODY_MAX, MIN_LEAD_MS } from './constants'

export type CreateInput =
  | { ok: true; value: { conversationId: string; body: string; scheduledFor: string } }
  | { ok: false; error: string }

export function validateCreateInput(input: unknown, now: Date): CreateInput {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Corpo inválido' }
  }
  const { conversation_id, body, scheduled_for } = input as Record<string, unknown>

  if (typeof conversation_id !== 'string' || !conversation_id) {
    return { ok: false, error: 'conversation_id é obrigatório' }
  }
  if (typeof body !== 'string' || !body.trim()) {
    return { ok: false, error: 'O texto não pode ficar vazio' }
  }
  const text = body.trim()
  if (text.length > BODY_MAX) {
    return { ok: false, error: `O texto passa de ${BODY_MAX} caracteres` }
  }
  if (typeof scheduled_for !== 'string') {
    return { ok: false, error: 'scheduled_for é obrigatório' }
  }
  const when = new Date(scheduled_for)
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: 'Data e hora inválidas' }
  }
  if (when.getTime() < now.getTime() + MIN_LEAD_MS) {
    return { ok: false, error: 'Escolha um horário pelo menos 30 segundos à frente' }
  }
  return {
    ok: true,
    value: { conversationId: conversation_id, body: text, scheduledFor: when.toISOString() },
  }
}
