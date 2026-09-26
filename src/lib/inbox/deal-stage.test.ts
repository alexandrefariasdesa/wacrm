import { describe, expect, it } from 'vitest'
import { canChangeStage, sortStages } from './deal-stage'

describe('canChangeStage', () => {
  it('só negócios em aberto podem trocar de etapa', () => {
    expect(canChangeStage('open')).toBe(true)
    expect(canChangeStage('won')).toBe(false)
    expect(canChangeStage('lost')).toBe(false)
    expect(canChangeStage(null)).toBe(false)
    expect(canChangeStage(undefined)).toBe(false)
  })
})

describe('sortStages', () => {
  it('ordena por position sem mutar a lista original', () => {
    const input = [{ id: 'b', position: 2 }, { id: 'a', position: 0 }, { id: 'c', position: 1 }]
    expect(sortStages(input).map((s) => s.id)).toEqual(['a', 'c', 'b'])
    expect(input.map((s) => s.id)).toEqual(['b', 'a', 'c'])
  })
})
