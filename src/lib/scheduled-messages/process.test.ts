import { describe, expect, it, vi } from 'vitest'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { processDueMessages } from './process'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const clock = () => NOW

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'm1', account_id: 'a1', conversation_id: 'c1', body: 'oi',
    scheduled_for: '2026-10-01T11:59:00.000Z', attempts: 1, ...over,
  }
}

function makeDb(rows: unknown[], ownsRow = true) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const touches: string[] = []
  const db = {
    rpc: vi.fn(async () => ({ data: rows, error: null })),
    from: vi.fn(() => ({
      update: (patch: Record<string, unknown>) => {
        const isTouch = Object.keys(patch).length === 1 && 'claimed_at' in patch
        let id = ''
        const q: Record<string, unknown> = {
          eq: (col: string, v: string) => {
            if (col === 'id') id = v
            return q
          },
          // "toque de posse": só devolve linha se a mensagem ainda é deste worker
          select: async () => {
            touches.push(id)
            return { data: ownsRow ? [{ id }] : [], error: null }
          },
          then: (res: (v: unknown) => unknown) => {
            if (!isTouch) updates.push({ id, patch })
            return Promise.resolve({ error: null }).then(res)
          },
        }
        return q
      },
    })),
  }
  return { db: db as never, updates, touches }
}

describe('processDueMessages', () => {
  it('envia e marca sent com message_id', async () => {
    const { db, updates } = makeDb([row()])
    const send = vi.fn(async () => ({ messageId: 'msg-9' }))
    const r = await processDueMessages(db, send, clock)
    expect(send).toHaveBeenCalledWith('a1', { conversationId: 'c1', messageType: 'text', contentText: 'oi' })
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0, missed: 0 })
    expect(updates[0].patch).toMatchObject({ status: 'sent', message_id: 'msg-9' })
    expect(updates[0].patch.sent_at).toBe(NOW.toISOString())
  })

  it('atraso > 1 h vira missed e NÃO envia', async () => {
    const { db, updates } = makeDb([row({ scheduled_for: '2026-10-01T10:59:59.000Z' })])
    const send = vi.fn()
    const r = await processDueMessages(db, send, clock)
    expect(send).not.toHaveBeenCalled()
    expect(r.missed).toBe(1)
    expect(updates[0].patch).toMatchObject({ status: 'missed' })
  })

  it('exatamente 1 h de atraso ainda envia', async () => {
    const { db } = makeDb([row({ scheduled_for: '2026-10-01T11:00:00.000Z' })])
    const send = vi.fn(async () => ({ messageId: 'x' }))
    await processDueMessages(db, send, clock)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('erro na 1ª/2ª tentativa volta a pending daqui a 1 min', async () => {
    const { db, updates } = makeDb([row({ attempts: 2 })])
    const send = vi.fn(async () => { throw new SendMessageError('channel', 'Canal desconectado', 502) })
    const r = await processDueMessages(db, send, clock)
    expect(r.retried).toBe(1)
    expect(updates[0].patch).toMatchObject({
      status: 'pending',
      last_error: 'Canal desconectado',
      scheduled_for: '2026-10-01T12:01:00.000Z',
    })
  })

  it('erro na 3ª tentativa vira failed com o motivo', async () => {
    const { db, updates } = makeDb([row({ attempts: 3 })])
    const send = vi.fn(async () => { throw new SendMessageError('channel', 'Canal desconectado', 502) })
    const r = await processDueMessages(db, send, clock)
    expect(r.failed).toBe(1)
    expect(updates[0].patch).toMatchObject({ status: 'failed', last_error: 'Canal desconectado' })
  })

  it('erro que não é SendMessageError também vira motivo legível', async () => {
    const { db, updates } = makeDb([row({ attempts: 3 })])
    const send = vi.fn(async () => { throw new Error('boom') })
    await processDueMessages(db, send, clock)
    expect(updates[0].patch).toMatchObject({ status: 'failed', last_error: 'boom' })
  })

  it('uma falha não impede as demais e o envio é em série', async () => {
    const { db, updates } = makeDb([row({ id: 'a', attempts: 3 }), row({ id: 'b' })])
    const order: string[] = []
    const send = vi.fn(async (_a: string, p: { conversationId: string; contentText: string }) => {
      order.push(p.contentText)
      if (order.length === 1) throw new Error('x')
      return { messageId: 'ok' }
    })
    const r = await processDueMessages(db, send, clock)
    expect(r).toMatchObject({ claimed: 2, failed: 1, sent: 1 })
    expect(updates.map((u) => u.id)).toEqual(['a', 'b'])
  })

  it('sem vencidas devolve zeros; erro do claim propaga', async () => {
    const { db } = makeDb([])
    expect(await processDueMessages(db, vi.fn(), clock)).toEqual({ claimed: 0, sent: 0, failed: 0, missed: 0, retried: 0, lost: 0 })
    const bad = { rpc: async () => ({ data: null, error: { message: 'db fora' } }) } as never
    await expect(processDueMessages(bad, vi.fn(), clock)).rejects.toThrow('db fora')
  })

  it('linha recuperada por outro worker (perdeu a posse) NÃO é enviada', async () => {
    const { db, updates } = makeDb([row()], false)
    const send = vi.fn()
    const r = await processDueMessages(db, send, clock)
    expect(send).not.toHaveBeenCalled()
    expect(r).toMatchObject({ claimed: 1, lost: 1, sent: 0 })
    expect(updates).toHaveLength(0)
  })

  it('confirma a posse imediatamente antes de cada envio', async () => {
    const { db, touches } = makeDb([row({ id: 'a' }), row({ id: 'b' })])
    await processDueMessages(db, vi.fn(async () => ({ messageId: 'x' })), clock)
    expect(touches).toEqual(['a', 'b'])
  })

  it('db_error depois do envio (mensagem já entregue) vira sent e NÃO retenta', async () => {
    const { db, updates } = makeDb([row({ attempts: 1 })])
    const send = vi.fn(async () => {
      throw new SendMessageError('db_error', 'Message sent to Meta but failed to save to DB: x', 500)
    })
    const r = await processDueMessages(db, send, clock)
    expect(r).toMatchObject({ sent: 1, retried: 0, failed: 0 })
    expect(updates[0].patch).toMatchObject({ status: 'sent', sent_at: NOW.toISOString() })
    expect(String(updates[0].patch.last_error)).toContain('não foi gravada')
  })
})
