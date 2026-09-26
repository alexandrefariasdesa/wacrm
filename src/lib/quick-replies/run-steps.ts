import type { SequenceStep } from './steps'

export type StepSend = (step: SequenceStep) => Promise<unknown>

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Envia os passos em ordem. A espera de cada passo (`delay_seconds`) vem ANTES dele.
 * Para na primeira falha (sem retentativa: retentar duplicaria o que já saiu).
 */
export async function sendSteps(
  steps: SequenceStep[],
  send: StepSend,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ sent: number; failed?: { index: number; error: string } }> {
  let sent = 0
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].delay_seconds > 0) await sleep(steps[i].delay_seconds * 1000)
    try {
      await send(steps[i])
      sent += 1
    } catch (err) {
      return { sent, failed: { index: i, error: err instanceof Error ? err.message : String(err) } }
    }
  }
  return { sent }
}
