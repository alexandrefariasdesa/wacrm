import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'sequence-editor.tsx'), 'utf8')

describe('editor de sequência: upload não sobrescreve edições feitas durante o envio', () => {
  it('o fim do upload lê o valor e o onChange MAIS RECENTES (refs), não os do início', () => {
    expect(src).toContain('valueRef')
    expect(src).toContain('onChangeRef')
    const onFile = src.slice(src.indexOf('const onFile'), src.indexOf('return (', src.indexOf('const onFile')))
    expect(onFile).toContain('onChangeRef.current(')
    expect(onFile).toContain('valueRef.current')
    expect(onFile).not.toMatch(/\bupdate\(i,/)
  })
})
