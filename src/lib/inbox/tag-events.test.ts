import { describe, expect, it, vi } from 'vitest'

function stubWindow() {
  const target = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  })
}

describe('tag-events', () => {
  it('entrega o evento aos ouvintes e para depois de cancelar', async () => {
    stubWindow()
    const { emitContactTagsChanged, onContactTagsChanged } = await import('./tag-events')
    const got: unknown[] = []
    const off = onContactTagsChanged((d) => got.push(d))
    emitContactTagsChanged('c1', [{ id: 't', user_id: 'u', name: 'A', color: '#fff', created_at: '' }])
    off()
    emitContactTagsChanged('c1', [])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ contactId: 'c1', tags: [{ id: 't' }] })
  })
})
