import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'quick-replies-manager.tsx'), 'utf8')

describe('editor de mensagens rápidas suporta sequência', () => {
  it('tem a aba Sequência e envia kind sequence com steps', () => {
    expect(src).toContain('kindSequence')
    expect(src).toContain('SequenceEditor')
    expect(src).toContain('kind: "sequence"')
    expect(src).toContain('steps')
  })
  it('valida antes de salvar e mostra a prévia dos passos na lista', () => {
    expect(src).toContain('validateSteps(')
    expect(src).toContain('describeSteps(')
  })
})
