import { describe, expect, it } from 'vitest'
import { buildQualifiedBody } from './build-body'

describe('buildQualifiedBody', () => {
  it('manda só dígitos e o instante em ISO', () => {
    expect(buildQualifiedBody({ phone: '+55 (21) 99999-0001', occurredAt: '2026-10-01T12:00:00Z' })).toEqual({
      event: 'qualified',
      phone: '5521999990001',
      occurred_at: '2026-10-01T12:00:00.000Z',
    })
  })
  it('null sem telefone ou com telefone curto', () => {
    expect(buildQualifiedBody({ phone: null, occurredAt: '2026-10-01T12:00:00Z' })).toBeNull()
    expect(buildQualifiedBody({ phone: '12345', occurredAt: '2026-10-01T12:00:00Z' })).toBeNull()
  })
})
