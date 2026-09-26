import { describe, expect, it, vi } from 'vitest'
import { sendSteps } from './run-steps'
import type { SequenceStep } from './steps'

const s = (text: string, delay_seconds = 0): SequenceStep => ({ type: 'text', text, delay_seconds })

describe('sendSteps', () => {
  it('envia em ordem e espera o delay de cada passo antes de enviá-lo', async () => {
    const log: string[] = []
    const send = vi.fn(async (st: SequenceStep) => { log.push(`send:${st.text}`) })
    const sleep = vi.fn(async (ms: number) => { log.push(`sleep:${ms}`) })
    const r = await sendSteps([s('a', 0), s('b', 5), s('c', 2)], send, sleep)
    expect(r).toEqual({ sent: 3 })
    expect(log).toEqual(['send:a', 'sleep:5000', 'send:b', 'sleep:2000', 'send:c'])
  })
  it('para na primeira falha, devolve o índice e não envia os seguintes', async () => {
    const send = vi.fn(async (st: SequenceStep) => { if (st.text === 'b') throw new Error('canal caído') })
    const r = await sendSteps([s('a'), s('b'), s('c')], send, async () => {})
    expect(r).toEqual({ sent: 1, failed: { index: 1, error: 'canal caído' } })
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('lista vazia não faz nada', async () => {
    expect(await sendSteps([], vi.fn(), async () => {})).toEqual({ sent: 0 })
  })
})
