import { describe, expect, it, vi } from 'vitest'
import { findOversizedMedia } from './channel-fit'
import type { SequenceStep } from './steps'

const MB = 1024 * 1024
const video = (url: string): SequenceStep => ({ type: 'video', media_url: url, delay_seconds: 0 })
const text: SequenceStep = { type: 'text', text: 'oi', delay_seconds: 0 }

describe('findOversizedMedia', () => {
  it('Evolution (unofficial) não consulta nada: os tetos são os do bucket', async () => {
    const head = vi.fn(async () => 30 * MB)
    expect(await findOversizedMedia([video('https://a/x.mp4')], 'unofficial', head)).toBeNull()
    expect(head).not.toHaveBeenCalled()
  })
  it('API oficial: vídeo de 30 MB passa do teto de 16 MB e devolve o passo', async () => {
    const head = vi.fn(async () => 30 * MB)
    const r = await findOversizedMedia([text, video('https://a/x.mp4')], 'cloud_api', head)
    expect(r).toEqual({ index: 1, type: 'video', bytes: 30 * MB, max: 16 * MB })
    expect(head).toHaveBeenCalledTimes(1) // texto não consulta
  })
  it('API oficial: imagem usa o teto de 5 MB', async () => {
    const r = await findOversizedMedia(
      [{ type: 'image', media_url: 'https://a/x.png', delay_seconds: 0 }], 'cloud_api', async () => 6 * MB,
    )
    expect(r).toMatchObject({ index: 0, type: 'image', max: 5 * MB })
  })
  it('dentro do teto, tamanho desconhecido e canal desconhecido não bloqueiam', async () => {
    expect(await findOversizedMedia([video('https://a/x.mp4')], 'cloud_api', async () => 10 * MB)).toBeNull()
    expect(await findOversizedMedia([video('https://a/x.mp4')], 'cloud_api', async () => null)).toBeNull()
    expect(await findOversizedMedia([video('https://a/x.mp4')], null, async () => 99 * MB)).toBeNull()
  })
  it('devolve o primeiro passo grande demais', async () => {
    const sizes: Record<string, number> = { 'https://a/1.mp4': 10 * MB, 'https://a/2.mp4': 20 * MB, 'https://a/3.mp4': 40 * MB }
    const r = await findOversizedMedia(
      [video('https://a/1.mp4'), video('https://a/2.mp4'), video('https://a/3.mp4')], 'cloud_api', async (u) => sizes[u],
    )
    expect(r?.index).toBe(1)
  })
})
