import { describe, expect, it } from 'vitest'
import { validateCreateInput } from './validate'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const ok = {
  conversation_id: 'c1',
  body: 'olá',
  scheduled_for: '2026-10-01T13:00:00.000Z',
}

describe('validateCreateInput', () => {
  it('aceita entrada válida e devolve texto aparado', () => {
    const r = validateCreateInput({ ...ok, body: '  olá  ' }, NOW)
    expect(r).toEqual({
      ok: true,
      value: { conversationId: 'c1', body: 'olá', scheduledFor: '2026-10-01T13:00:00.000Z' },
    })
  })
  it('recusa texto vazio ou só espaços', () => {
    expect(validateCreateInput({ ...ok, body: '   ' }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, body: '' }, NOW).ok).toBe(false)
  })
  it('recusa texto acima de 4096', () => {
    expect(validateCreateInput({ ...ok, body: 'a'.repeat(4097) }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, body: 'a'.repeat(4096) }, NOW).ok).toBe(true)
  })
  it('recusa horário no passado e a menos de 30 s', () => {
    expect(validateCreateInput({ ...ok, scheduled_for: '2026-10-01T11:00:00.000Z' }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, scheduled_for: '2026-10-01T12:00:10.000Z' }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, scheduled_for: '2026-10-01T12:00:31.000Z' }, NOW).ok).toBe(true)
  })
  it('recusa data inválida, tipos errados e conversa ausente', () => {
    expect(validateCreateInput({ ...ok, scheduled_for: 'amanhã' }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, scheduled_for: 123 }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, conversation_id: '' }, NOW).ok).toBe(false)
    expect(validateCreateInput({ ...ok, body: 5 }, NOW).ok).toBe(false)
    expect(validateCreateInput(null, NOW).ok).toBe(false)
  })
})
