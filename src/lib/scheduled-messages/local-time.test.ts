import { describe, expect, it } from 'vitest'
import { defaultLocalSlot, localToIso } from './local-time'

describe('localToIso', () => {
  it('converte data+hora locais para o instante certo (ida e volta)', () => {
    const iso = localToIso('2026-10-01', '09:30')!
    const d = new Date(iso)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(9)
    expect(d.getDate()).toBe(1)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(30)
  })
  it('devolve null para entrada vazia ou inválida', () => {
    expect(localToIso('', '09:30')).toBeNull()
    expect(localToIso('2026-10-01', '')).toBeNull()
    expect(localToIso('2026-13-45', '09:30')).toBeNull()
  })
})

describe('defaultLocalSlot', () => {
  it('sugere agora + 1 h arredondado para cima em 5 min', () => {
    const now = new Date(2026, 9, 1, 10, 2, 0) // 10:02 local
    expect(defaultLocalSlot(now)).toEqual({ date: '2026-10-01', time: '11:05' })
  })
  it('vira o dia quando passa da meia-noite', () => {
    const now = new Date(2026, 9, 1, 23, 40, 0)
    expect(defaultLocalSlot(now)).toEqual({ date: '2026-10-02', time: '00:40' })
  })
})
