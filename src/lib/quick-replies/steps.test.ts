import { describe, expect, it } from 'vitest'
import { describeSteps, stepToSendParams, totalDelaySeconds, validateSteps } from './steps'

const text = (over: Record<string, unknown> = {}) => ({ type: 'text', text: 'oi', delay_seconds: 0, ...over })
const video = (over: Record<string, unknown> = {}) => ({
  type: 'video', media_url: 'https://x.supabase.co/storage/v1/object/public/chat-media/a.mp4', delay_seconds: 0, ...over,
})

describe('validateSteps', () => {
  it('aceita uma sequência válida e devolve só os campos conhecidos, com texto aparado', () => {
    const r = validateSteps([text({ text: '  oi  ', lixo: 1 }), video({ caption: 'depoimento' })])
    expect(r).toEqual({
      ok: true,
      steps: [
        { type: 'text', text: 'oi', delay_seconds: 0 },
        { type: 'video', media_url: 'https://x.supabase.co/storage/v1/object/public/chat-media/a.mp4', caption: 'depoimento', delay_seconds: 0 },
      ],
    })
  })
  it('recusa não-array, vazio e mais de 10 passos', () => {
    expect(validateSteps('x').ok).toBe(false)
    expect(validateSteps([]).ok).toBe(false)
    expect(validateSteps(Array.from({ length: 11 }, () => text())).ok).toBe(false)
    expect(validateSteps(Array.from({ length: 10 }, () => text())).ok).toBe(true)
  })
  it('recusa tipo desconhecido e passo que não é objeto', () => {
    expect(validateSteps([{ type: 'audio', delay_seconds: 0 }]).ok).toBe(false)
    expect(validateSteps(['oi']).ok).toBe(false)
  })
  it('texto exige text não vazio e ≤ 4096', () => {
    expect(validateSteps([text({ text: '   ' })]).ok).toBe(false)
    expect(validateSteps([text({ text: undefined })]).ok).toBe(false)
    expect(validateSteps([text({ text: 'a'.repeat(4097) })]).ok).toBe(false)
    expect(validateSteps([text({ text: 'a'.repeat(4096) })]).ok).toBe(true)
  })
  it('mídia exige media_url https e legenda ≤ 1024', () => {
    expect(validateSteps([video({ media_url: undefined })]).ok).toBe(false)
    expect(validateSteps([video({ media_url: 'http://x/a.mp4' })]).ok).toBe(false)
    expect(validateSteps([video({ media_url: 'javascript:alert(1)' })]).ok).toBe(false)
    expect(validateSteps([video({ caption: 'a'.repeat(1025) })]).ok).toBe(false)
    expect(validateSteps([video({ caption: 'a'.repeat(1024) })]).ok).toBe(true)
  })
  it('espera: inteiro 0–60 e soma ≤ 300', () => {
    expect(validateSteps([text({ delay_seconds: -1 })]).ok).toBe(false)
    expect(validateSteps([text({ delay_seconds: 1.5 })]).ok).toBe(false)
    expect(validateSteps([text({ delay_seconds: 61 })]).ok).toBe(false)
    expect(validateSteps([text({ delay_seconds: '5' })]).ok).toBe(false)
    expect(validateSteps([text({ delay_seconds: 60 })]).ok).toBe(true)
    const six = Array.from({ length: 6 }, () => text({ delay_seconds: 60 })) // 360 s
    expect(validateSteps(six).ok).toBe(false)
    const five = Array.from({ length: 5 }, () => text({ delay_seconds: 60 })) // 300 s
    expect(validateSteps(five).ok).toBe(true)
  })
})

describe('helpers', () => {
  it('totalDelaySeconds soma as esperas', () => {
    expect(totalDelaySeconds([text({ delay_seconds: 5 }), text({ delay_seconds: 7 })] as never)).toBe(12)
  })
  it('stepToSendParams mapeia texto e mídia (legenda vira contentText)', () => {
    expect(stepToSendParams({ type: 'text', text: 'oi', delay_seconds: 0 })).toEqual({ messageType: 'text', contentText: 'oi' })
    expect(stepToSendParams({ type: 'video', media_url: 'https://a/b.mp4', caption: 'c', delay_seconds: 0 })).toEqual({
      messageType: 'video', contentText: 'c', mediaUrl: 'https://a/b.mp4',
    })
    expect(stepToSendParams({ type: 'document', media_url: 'https://a/b.pdf', filename: 'b.pdf', delay_seconds: 0 })).toEqual({
      messageType: 'document', mediaUrl: 'https://a/b.pdf', filename: 'b.pdf',
    })
  })
  it('describeSteps numera os passos', () => {
    const labels = { text: 'Texto', image: 'Imagem', video: 'Vídeo', document: 'Documento' }
    expect(describeSteps([text(), video(), text()] as never, labels)).toBe('1. Texto · 2. Vídeo · 3. Texto')
  })
})
