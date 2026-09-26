export function buildQualifiedBody(input: { phone: string | null; occurredAt: string }) {
  const digits = (input.phone ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  return {
    event: 'qualified' as const,
    phone: digits,
    occurred_at: new Date(input.occurredAt).toISOString(),
  }
}
