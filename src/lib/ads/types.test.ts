import { describe, expect, it } from 'vitest'
import { deriveMetrics } from './types'

/**
 * CPL, CPA e ROAS são o motivo do painel existir — são eles que dizem
 * qual criativo cortar. O único jeito de errarem é na divisão por zero,
 * e a diferença entre `0` e `null` aqui não é estética: um CPL exibido
 * como "R$ 0" seria lido como "lead de graça" e o anúncio ficaria no ar.
 */
describe('deriveMetrics', () => {
  it('calcula as quatro razões no caso normal', () => {
    const m = deriveMetrics({ spend: 1000, leads: 50, deals_won: 5, revenue: 4000 })
    expect(m.cpl).toBe(20)
    expect(m.cpa).toBe(200)
    expect(m.roas).toBe(4)
    expect(m.conversionRate).toBe(0.1)
    expect(m.averageTicket).toBe(800)
  })

  it('devolve null — nunca 0 — quando não houve lead', () => {
    const m = deriveMetrics({ spend: 500, leads: 0, deals_won: 0, revenue: 0 })
    expect(m.cpl).toBeNull()
    expect(m.conversionRate).toBeNull()
  })

  it('devolve null — nunca Infinity — quando não houve gasto', () => {
    // Acontece de verdade: o lead do CTWA chega na hora, o gasto do dia
    // só é sincronizado depois. Infinity vazaria para a tela como "∞x".
    const m = deriveMetrics({ spend: 0, leads: 10, deals_won: 1, revenue: 900 })
    expect(m.roas).toBeNull()
    expect(m.cpl).toBe(0)
  })

  it('devolve null para CPA e ticket médio sem venda', () => {
    const m = deriveMetrics({ spend: 1000, leads: 40, deals_won: 0, revenue: 0 })
    expect(m.cpa).toBeNull()
    expect(m.averageTicket).toBeNull()
    // ...mas o CPL continua válido: houve lead.
    expect(m.cpl).toBe(25)
  })

  it('tudo zerado devolve tudo null, sem NaN', () => {
    const m = deriveMetrics({ spend: 0, leads: 0, deals_won: 0, revenue: 0 })
    expect(m.cpl).toBeNull()
    expect(m.cpa).toBeNull()
    expect(m.roas).toBeNull()
    expect(m.conversionRate).toBeNull()
    expect(m.averageTicket).toBeNull()
    expect(Object.values(m).some((v) => Number.isNaN(v))).toBe(false)
  })

  it('ROAS abaixo de 1 é o sinal de anúncio no prejuízo', () => {
    const m = deriveMetrics({ spend: 1000, leads: 20, deals_won: 1, revenue: 400 })
    expect(m.roas).toBeLessThan(1)
  })
})
