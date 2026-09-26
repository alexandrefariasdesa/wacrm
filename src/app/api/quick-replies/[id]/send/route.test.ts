import { beforeEach, describe, expect, it, vi } from 'vitest'

let quickReply: Record<string, unknown> | null
let conversation: Record<string, unknown> | null
const sends: Array<Record<string, unknown>> = []
const afterFns: Array<() => Promise<void> | void> = []
let failOn: number | null = null

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => Promise<void> | void) => { afterFns.push(fn) },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: fakeSupabase(), accountId: 'acct-1', userId: 'u1' })),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))

vi.mock('@/lib/whatsapp/send-message', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp/send-message')>()
  return {
    ...real,
    sendMessageToConversation: vi.fn(async (_db: unknown, _acct: string, params: Record<string, unknown>) => {
      sends.push(params)
      if (failOn !== null && sends.length === failOn) {
        throw new real.SendMessageError('channel', 'Canal desconectado', 502)
      }
      return { messageId: `m${sends.length}`, whatsappMessageId: 'w' }
    }),
  }
})

function fakeSupabase() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: table === 'quick_replies' ? quickReply : conversation, error: null }),
          }),
        }),
      }),
    }),
  }
}

import { POST } from './route'

const call = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'qr-1' }) })

const VIDEO = 'https://x.supabase.co/storage/v1/object/public/chat-media/a.mp4'

beforeEach(() => {
  sends.length = 0
  afterFns.length = 0
  failOn = null
  quickReply = { id: 'qr-1', kind: 'text', content_text: 'Olá!', steps: null }
  conversation = { id: 'c1' }
})

describe('POST /api/quick-replies/[id]/send', () => {
  it('texto: envia 1 mensagem e responde 202', async () => {
    const res = await call({ conversation_id: 'c1' })
    expect(res.status).toBe(202)
    expect(sends).toEqual([{ conversationId: 'c1', messageType: 'text', contentText: 'Olá!' }])
    expect(afterFns).toHaveLength(0)
  })

  it('sequência: 1º passo sai na requisição, o resto roda em after() na ordem', async () => {
    quickReply = {
      id: 'qr-1', kind: 'sequence', content_text: null,
      steps: [
        { type: 'text', text: 'a', delay_seconds: 0 },
        { type: 'video', media_url: VIDEO, caption: 'depoimento', delay_seconds: 0 },
        { type: 'text', text: 'c', delay_seconds: 0 },
      ],
    }
    const res = await call({ conversation_id: 'c1' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ steps: 3 })
    expect(sends).toHaveLength(1) // só o 1º, antes de responder
    for (const fn of afterFns) await fn()
    expect(sends.map((s) => s.messageType)).toEqual(['text', 'video', 'text'])
    expect(sends[1]).toMatchObject({ mediaUrl: VIDEO, contentText: 'depoimento' })
  })

  it('falha no 1º passo: devolve o erro e não agenda o resto', async () => {
    quickReply = { id: 'qr-1', kind: 'sequence', steps: [{ type: 'text', text: 'a', delay_seconds: 0 }, { type: 'text', text: 'b', delay_seconds: 0 }] }
    failOn = 1
    const res = await call({ conversation_id: 'c1' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Canal desconectado' })
    expect(afterFns).toHaveLength(0)
  })

  it('falha no 2º passo: o 3º não é enviado', async () => {
    quickReply = { id: 'qr-1', kind: 'sequence', steps: [0, 1, 2].map((i) => ({ type: 'text', text: `t${i}`, delay_seconds: 0 })) }
    failOn = 2
    await call({ conversation_id: 'c1' })
    for (const fn of afterFns) await fn()
    expect(sends).toHaveLength(2)
  })

  it('interactive: 400 (botões só saem pelo compositor)', async () => {
    quickReply = { id: 'qr-1', kind: 'interactive' }
    expect((await call({ conversation_id: 'c1' })).status).toBe(400)
    expect(sends).toHaveLength(0)
  })

  it('404 quando a mensagem rápida ou a conversa não é da conta', async () => {
    quickReply = null
    expect((await call({ conversation_id: 'c1' })).status).toBe(404)
    quickReply = { id: 'qr-1', kind: 'text', content_text: 'x' }
    conversation = null
    expect((await call({ conversation_id: 'c1' })).status).toBe(404)
    expect(sends).toHaveLength(0)
  })

  it('422 quando os steps salvos estão inválidos', async () => {
    quickReply = { id: 'qr-1', kind: 'sequence', steps: [{ type: 'banana' }] }
    expect((await call({ conversation_id: 'c1' })).status).toBe(422)
    expect(sends).toHaveLength(0)
  })

  it('400 sem conversation_id ou com JSON inválido', async () => {
    expect((await call({})).status).toBe(400)
    const res = await POST(new Request('http://x', { method: 'POST', body: '{ruim' }), { params: Promise.resolve({ id: 'qr-1' }) })
    expect(res.status).toBe(400)
  })
})
