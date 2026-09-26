import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'contact-sidebar.tsx'), 'utf8')

describe('barra lateral do lead', () => {
  it('o painel de mensagens rápidas vem antes das etiquetas', () => {
    const panel = src.indexOf('<QuickRepliesPanel')
    const tags = src.indexOf('tSidebar("tags")')
    expect(panel).toBeGreaterThan(-1)
    expect(tags).toBeGreaterThan(panel)
  })
  it('recebe o id da conversa', () => {
    expect(src).toContain('conversationId')
  })
})
