import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'contact-sidebar.tsx'), 'utf8')

describe('barra lateral: resposta atrasada de um contato não vaza para outro', () => {
  it('o seletor de etiquetas é recriado por contato e as gravações conferem o contato atual', () => {
    expect(src).toContain('contactIdRef')
    expect(src).toMatch(/<ContactTagPicker\s+key=\{contact\.id\}/)
    expect(src).toContain('contactIdRef.current === ')
  })
})
