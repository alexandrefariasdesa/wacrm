import { describe, expect, it, vi } from 'vitest'
import { drainAzimuteEvents } from './drain'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const clock = () => NOW
const URL_ = 'https://azimute.test/api/webhooks/crm/SEGREDO'

function ev(over: Record<string, unknown> = {}) {
  return { id: 'e1', contact_id: 'c1', occurred_at: '2026-10-01T11:59:00.000Z', attempts: 1, ...over }
}

function makeDb(events: unknown[], phone: string | null = '5521999990001') {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const db = {
    rpc: vi.fn(async () => ({ data: events, error: null })),
    from: vi.fn((table: string) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: phone ? { phone } : null, error: null }) }),
          }),
        }
      }
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, id: string) => ({
            eq: async () => {
              updates.push({ id, patch })
              return { error: null }
            },
          }),
        }),
      }
    }),
  }
  return { db: db as never, updates }
}

const resp = (status: number, body = '') => new Response(body, { status })

describe('drainAzimuteEvents', () => {
  it('2xx marca sent e manda o corpo certo', async () => {
    const { db, updates } = makeDb([ev()])
    const f = vi.fn(async () => resp(200, '{"ok":true}'))
    const r = await drainAzimuteEvents(db, URL_, f as never, clock)
    expect(f).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe(URL_)
    expect(JSON.parse(String(init.body))).toEqual({
      event: 'qualified',
      phone: '5521999990001',
      occurred_at: '2026-10-01T11:59:00.000Z',
    })
    expect(r).toMatchObject({ claimed: 1, sent: 1 })
    expect(updates[0].patch).toMatchObject({ status: 'sent', sent_at: NOW.toISOString() })
  })

  it('404 do Azimute vira skipped e NÃO retenta', async () => {
    const { db, updates } = makeDb([ev()])
    const r = await drainAzimuteEvents(
      db, URL_, (async () => resp(404, '{"error":"Contato não encontrado"}')) as never, clock,
    )
    expect(r.skipped).toBe(1)
    expect(updates[0].patch).toMatchObject({ status: 'skipped' })
    expect(String(updates[0].patch.last_error)).toContain('404')
  })

  it('400 também é skipped', async () => {
    const { db } = makeDb([ev()])
    const r = await drainAzimuteEvents(db, URL_, (async () => resp(400, 'x')) as never, clock)
    expect(r.skipped).toBe(1)
  })

  it('5xx na 1ª tentativa volta a pending daqui a 1 min; na 3ª, daqui a 15 min', async () => {
    const a = makeDb([ev({ attempts: 1 })])
    await drainAzimuteEvents(a.db, URL_, (async () => resp(503)) as never, clock)
    expect(a.updates[0].patch).toMatchObject({ status: 'pending', next_attempt_at: '2026-10-01T12:01:00.000Z' })
    const b = makeDb([ev({ attempts: 3 })])
    await drainAzimuteEvents(b.db, URL_, (async () => resp(503)) as never, clock)
    expect(b.updates[0].patch).toMatchObject({ next_attempt_at: '2026-10-01T12:15:00.000Z' })
  })

  it('5xx/erro de rede na 5ª tentativa vira failed', async () => {
    const { db, updates } = makeDb([ev({ attempts: 5 })])
    const r = await drainAzimuteEvents(
      db, URL_, (async () => { throw new Error('ECONNREFUSED') }) as never, clock,
    )
    expect(r.failed).toBe(1)
    expect(updates[0].patch).toMatchObject({ status: 'failed' })
    expect(String(updates[0].patch.last_error)).toContain('ECONNREFUSED')
  })

  it('contato sem telefone: skipped e sem POST', async () => {
    const { db, updates } = makeDb([ev()], null)
    const f = vi.fn()
    const r = await drainAzimuteEvents(db, URL_, f as never, clock)
    expect(f).not.toHaveBeenCalled()
    expect(r.skipped).toBe(1)
    expect(updates[0].patch).toMatchObject({ status: 'skipped', last_error: 'contato sem telefone' })
  })

  it('a URL com a chave nunca vai parar no last_error', async () => {
    const { db, updates } = makeDb([ev({ attempts: 5 })])
    await drainAzimuteEvents(
      db, URL_, (async () => { throw new Error(`falhou em ${URL_}`) }) as never, clock,
    )
    expect(String(updates[0].patch.last_error)).not.toContain('SEGREDO')
  })

  it('erro do claim propaga', async () => {
    const bad = { rpc: async () => ({ data: null, error: { message: 'db fora' } }) } as never
    await expect(drainAzimuteEvents(bad, URL_, vi.fn() as never, clock)).rejects.toThrow('db fora')
  })
})
