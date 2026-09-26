import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'message-composer.tsx'), 'utf8')

describe('compositor usa o limite por canal', () => {
  it('valida o tamanho com mediaMaxBytes e não com o teto fixo', () => {
    expect(src).toContain('mediaMaxBytes(')
    expect(src).not.toContain('MEDIA_MAX_BYTES_BY_KIND[kind]')
    expect(src).not.toContain('MEDIA_MAX_BYTES_BY_KIND.audio')
  })
  it('recebe o tipo do canal por prop', () => {
    expect(src).toContain('channelKind')
  })
})
