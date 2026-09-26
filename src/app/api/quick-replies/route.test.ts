import { beforeEach, describe, expect, it, vi } from 'vitest'

const inserted: Array<Record<string, unknown>> = []

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ accountId: 'acct-1', userId: 'u1' })),
  getCurrentAccount: vi.fn(),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'qr-1', ...row }, error: null }) }) }
      },
    }),
  }),
}))

import { POST } from './route'

const post = (body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))
const goodSteps = [
  { type: 'text', text: 'Oi!', delay_seconds: 0 },
  { type: 'video', media_url: 'https://x.supabase.co/storage/v1/object/public/chat-media/a.mp4', delay_seconds: 5 },
]

beforeEach(() => { inserted.length = 0 })

describe('POST /api/quick-replies com sequência', () => {
  it('cria a sequência com steps validados e sem content_text', async () => {
    const res = await post({ title: 'Depoimentos', kind: 'sequence', steps: goodSteps })
    expect(res.status).toBe(201)
    expect(inserted[0]).toMatchObject({ account_id: 'acct-1', user_id: 'u1', kind: 'sequence', title: 'Depoimentos', content_text: null })
    expect(inserted[0].steps).toEqual(goodSteps)
  })
  it('400 com steps inválidos (vazio, espera fora do limite, ausente)', async () => {
    expect((await post({ title: 'x', kind: 'sequence', steps: [] })).status).toBe(400)
    expect((await post({ title: 'x', kind: 'sequence', steps: [{ type: 'text', text: 'a', delay_seconds: 99 }] })).status).toBe(400)
    expect((await post({ title: 'x', kind: 'sequence' })).status).toBe(400)
    expect(inserted).toHaveLength(0)
  })
  it('texto continua funcionando e não grava steps', async () => {
    const res = await post({ title: 'Oi', kind: 'text', content_text: 'olá' })
    expect(res.status).toBe(201)
    expect(inserted[0]).toMatchObject({ kind: 'text', content_text: 'olá', steps: null })
  })
})
