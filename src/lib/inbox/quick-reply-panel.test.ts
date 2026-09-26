import { describe, expect, it } from 'vitest'
import { panelItems, quickReplyPreview } from './quick-reply-panel'
import type { QuickReply } from '@/types'

const qr = (over: Partial<QuickReply>): QuickReply => ({
  id: 'i', account_id: 'a', user_id: 'u', title: 'T', kind: 'text', content_text: 'olá',
  created_at: '', updated_at: '', ...over,
})
const labels = { text: 'Texto', image: 'Imagem', video: 'Vídeo', document: 'Documento' }

describe('panelItems', () => {
  it('não lista mensagens interativas (botões não existem no Evolution)', () => {
    const items = [qr({ id: '1' }), qr({ id: '2', kind: 'interactive' }), qr({ id: '3', kind: 'sequence', steps: [] })]
    expect(panelItems(items, '').map((i) => i.id)).toEqual(['1', '3'])
  })
  it('filtra por título e prévia, ignorando caixa e acento', () => {
    const items = [qr({ id: '1', title: 'Preço' }), qr({ id: '2', title: 'Horário', content_text: 'Atendemos às 9h' })]
    expect(panelItems(items, 'PRECO').map((i) => i.id)).toEqual(['1'])
    expect(panelItems(items, 'atendemos').map((i) => i.id)).toEqual(['2'])
    expect(panelItems(items, 'zzz')).toEqual([])
  })
})

describe('quickReplyPreview', () => {
  it('texto mostra o conteúdo; sequência mostra os passos', () => {
    expect(quickReplyPreview(qr({ content_text: 'Oi tudo bem' }), labels)).toBe('Oi tudo bem')
    expect(
      quickReplyPreview(
        qr({ kind: 'sequence', steps: [{ type: 'text', text: 'a', delay_seconds: 0 }, { type: 'video', media_url: 'https://a/b.mp4', delay_seconds: 0 }] }),
        labels,
      ),
    ).toBe('1. Texto · 2. Vídeo')
  })
})
