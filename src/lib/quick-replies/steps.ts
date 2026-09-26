export type StepType = 'text' | 'image' | 'video' | 'document'

export interface SequenceStep {
  type: StepType
  text?: string
  caption?: string
  media_url?: string
  filename?: string
  delay_seconds: number
}

export const MAX_STEPS = 10
export const MAX_STEP_DELAY_S = 60
export const MAX_TOTAL_DELAY_S = 300
export const TEXT_MAX = 4096
export const CAPTION_MAX = 1024

const TYPES: readonly StepType[] = ['text', 'image', 'video', 'document']

export type StepsResult = { ok: true; steps: SequenceStep[] } | { ok: false; error: string }

export function validateSteps(input: unknown): StepsResult {
  if (!Array.isArray(input)) return { ok: false, error: 'steps deve ser uma lista' }
  if (input.length < 1) return { ok: false, error: 'A sequência precisa de pelo menos 1 passo' }
  if (input.length > MAX_STEPS) return { ok: false, error: `A sequência tem no máximo ${MAX_STEPS} passos` }

  const steps: SequenceStep[] = []
  for (let i = 0; i < input.length; i++) {
    const n = i + 1
    const raw = input[i]
    if (!raw || typeof raw !== 'object') return { ok: false, error: `Passo ${n} inválido` }
    const r = raw as Record<string, unknown>

    if (typeof r.type !== 'string' || !TYPES.includes(r.type as StepType)) {
      return { ok: false, error: `Passo ${n}: tipo inválido` }
    }
    const type = r.type as StepType

    const delay = r.delay_seconds
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > MAX_STEP_DELAY_S) {
      return { ok: false, error: `Passo ${n}: a espera deve ser um inteiro de 0 a ${MAX_STEP_DELAY_S} segundos` }
    }

    if (type === 'text') {
      const text = typeof r.text === 'string' ? r.text.trim() : ''
      if (!text) return { ok: false, error: `Passo ${n}: o texto não pode ficar vazio` }
      if (text.length > TEXT_MAX) return { ok: false, error: `Passo ${n}: o texto passa de ${TEXT_MAX} caracteres` }
      steps.push({ type, text, delay_seconds: delay })
      continue
    }

    const url = typeof r.media_url === 'string' ? r.media_url.trim() : ''
    if (!/^https:\/\//i.test(url)) return { ok: false, error: `Passo ${n}: falta o arquivo (URL https)` }
    const step: SequenceStep = { type, media_url: url, delay_seconds: delay }
    if (typeof r.caption === 'string' && r.caption.trim()) {
      if (r.caption.length > CAPTION_MAX) {
        return { ok: false, error: `Passo ${n}: a legenda passa de ${CAPTION_MAX} caracteres` }
      }
      step.caption = r.caption.trim()
    }
    if (type === 'document' && typeof r.filename === 'string' && r.filename.trim()) {
      step.filename = r.filename.trim()
    }
    steps.push(step)
  }

  if (totalDelaySeconds(steps) > MAX_TOTAL_DELAY_S) {
    return { ok: false, error: `A soma das esperas passa de ${MAX_TOTAL_DELAY_S} segundos` }
  }
  return { ok: true, steps }
}

export function totalDelaySeconds(steps: SequenceStep[]): number {
  return steps.reduce((sum, s) => sum + s.delay_seconds, 0)
}

export function stepToSendParams(step: SequenceStep): {
  messageType: StepType
  contentText?: string
  mediaUrl?: string
  filename?: string
} {
  if (step.type === 'text') return { messageType: 'text', contentText: step.text }
  const out: { messageType: StepType; contentText?: string; mediaUrl?: string; filename?: string } = {
    messageType: step.type,
    mediaUrl: step.media_url,
  }
  if (step.caption && step.type !== 'document') out.contentText = step.caption
  if (step.type === 'document' && step.filename) out.filename = step.filename
  return out
}

export function describeSteps(steps: SequenceStep[], labels: Record<StepType, string>): string {
  return steps.map((s, i) => `${i + 1}. ${labels[s.type]}`).join(' · ')
}
