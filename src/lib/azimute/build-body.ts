export type AzimuteEventKind = 'qualified' | 'link_sent' | 'paid'

export function buildEventBody(input: {
  kind: AzimuteEventKind
  phone: string | null
  occurredAt: string
}) {
  const digits = (input.phone ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  return {
    event: input.kind,
    phone: digits,
    occurred_at: new Date(input.occurredAt).toISOString(),
  }
}

/** Atalho antigo, mantido para os testes e chamadas existentes. */
export function buildQualifiedBody(input: { phone: string | null; occurredAt: string }) {
  return buildEventBody({ kind: 'qualified', ...input })
}
