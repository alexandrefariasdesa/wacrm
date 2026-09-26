import { describe, expect, it } from 'vitest'
import { canCreateTag, filterTagOptions, pickTagColor } from './tag-picker'
import type { Tag } from '@/types'

const t = (id: string, name: string): Tag => ({ id, user_id: 'u', name, color: '#fff', created_at: '' })
const all = [t('1', 'Quente'), t('2', 'Curso: CFO'), t('3', 'origem:lp')]

describe('filterTagOptions', () => {
  it('sem busca devolve tudo; com busca ignora caixa e acento', () => {
    expect(filterTagOptions(all, '')).toHaveLength(3)
    expect(filterTagOptions(all, 'QUENTE').map((x) => x.id)).toEqual(['1'])
    expect(filterTagOptions(all, 'cfo').map((x) => x.id)).toEqual(['2'])
    expect(filterTagOptions(all, 'zzz')).toEqual([])
  })
})

describe('canCreateTag', () => {
  it('só quando há texto e nenhuma etiqueta com o mesmo nome (sem caixa/espaços)', () => {
    expect(canCreateTag('Novo', all)).toBe(true)
    expect(canCreateTag('  quente ', all)).toBe(false)
    expect(canCreateTag('', all)).toBe(false)
    expect(canCreateTag('   ', all)).toBe(false)
  })
})

describe('pickTagColor', () => {
  it('é determinística e vem da paleta', () => {
    expect(pickTagColor('Quente')).toBe(pickTagColor('Quente'))
    expect(pickTagColor('Quente')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
