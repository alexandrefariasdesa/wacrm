import { beforeEach, describe, expect, it, vi } from 'vitest'

let conversation: Record<string, unknown> | null = { id: 'c1' }
let insertResult: { data: unknown; error: unknown } = { data: { id: 'sm-1' }, error: null }
let cancelRows: Array<{ id: string }> = [{ id: 'sm-1' }]
const inserted: Array<Record<string, unknown>> = []

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conversation, error: null }) }) }),
          }),
        }
      }
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: async () => insertResult }) }
        },
        update: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: cancelRows, error: null }) }) }) }),
        }),
      }
    },
  }
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: fakeSupabase(), accountId: 'acct-1', userId: 'u1' })),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}))

import { POST } from './route'
import { DELETE } from './[id]/route'

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  conversation = { id: 'c1' }
  insertResult = { data: { id: 'sm-1' }, error: null }
  cancelRows = [{ id: 'sm-1' }]
  inserted.length = 0
})

describe('POST /api/whatsapp/scheduled', () => {
  it('cria com created_by e account_id do servidor (não do corpo)', async () => {
    const res = await post({
      conversation_id: 'c1', body: ' oi ', scheduled_for: FUTURE, account_id: 'hack', created_by: 'hack',
    })
    expect(res.status).toBe(201)
    expect(inserted[0]).toMatchObject({
      account_id: 'acct-1', created_by: 'u1', conversation_id: 'c1', body: 'oi', status: 'pending',
    })
  })
  it('400 para horário no passado e para texto vazio', async () => {
    expect((await post({ conversation_id: 'c1', body: 'oi', scheduled_for: '2020-01-01T00:00:00Z' })).status).toBe(400)
    expect((await post({ conversation_id: 'c1', body: '  ', scheduled_for: FUTURE })).status).toBe(400)
    expect(inserted).toHaveLength(0)
  })
  it('404 quando a conversa não é da conta', async () => {
    conversation = null
    expect((await post({ conversation_id: 'c1', body: 'oi', scheduled_for: FUTURE })).status).toBe(404)
    expect(inserted).toHaveLength(0)
  })
  it('400 com JSON inválido', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: '{nao-json' }))
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/whatsapp/scheduled/[id]', () => {
  const del = () =>
    DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'sm-1' }) })
  it('200 quando cancela uma pendente', async () => {
    expect((await del()).status).toBe(200)
  })
  it('409 quando já não está pendente (enviando/enviada) ou não existe', async () => {
    cancelRows = []
    expect((await del()).status).toBe(409)
  })
})
