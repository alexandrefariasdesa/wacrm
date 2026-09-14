import { describe, expect, it } from 'vitest'
import {
  buildCapiEvent,
  buildFbc,
  normalizeEmail,
  normalizePhone,
  sha256,
  type PendingEvent,
} from './capi'

const NOW = Date.parse('2026-09-14T12:00:00Z')

const event: PendingEvent = {
  id: 'e1',
  event_name: 'LeadQualificado',
  event_id: 'deal-1:qualified',
  event_time: '2026-09-14T11:00:00Z',
  value: null,
  currency: null,
  contact_id: 'contact-1',
}

const signals = {
  email: ' Aluno@Exemplo.com ',
  phone: '+55 (24) 98139-2704',
  fbc: 'fb.1.1757800000000.IwAR',
  fbp: 'fb.1.1757800000000.123',
  fromMeta: true,
}

describe('normalização', () => {
  it('e-mail minúsculo e sem espaço; lixo vira null', () => {
    expect(normalizeEmail(' A@B.com ')).toBe('a@b.com')
    expect(normalizeEmail('sem-arroba')).toBeNull()
  })
  it('telefone só com dígitos, com o país', () => {
    expect(normalizePhone('+55 (24) 98139-2704')).toBe('5524981392704')
    expect(normalizePhone('123')).toBeNull()
  })
})

describe('buildFbc', () => {
  it('o cookie da página vence', () => {
    expect(buildFbc('fb.1.1.x', 'outro', '2026-09-14T00:00:00Z')).toBe('fb.1.1.x')
  })
  it('monta a partir do fbclid com os milissegundos do clique', () => {
    expect(buildFbc(null, 'IwAR9', '2026-09-14T00:00:00.000Z')).toBe(
      `fb.1.${Date.parse('2026-09-14T00:00:00.000Z')}.IwAR9`,
    )
  })
  it('sem fbclid não inventa', () => {
    expect(buildFbc(null, null, '2026-09-14T00:00:00Z')).toBeNull()
  })
})

describe('buildCapiEvent', () => {
  it('monta o evento com dados HASHEADOS, nunca em claro', () => {
    const r = buildCapiEvent(event, signals, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = r.payload as { user_data: Record<string, unknown>; [k: string]: unknown }
    expect(p.event_name).toBe('LeadQualificado')
    expect(p.event_id).toBe('deal-1:qualified')
    expect(p.action_source).toBe('system_generated')
    expect(p.event_time).toBe(Math.floor(Date.parse(event.event_time) / 1000))
    expect(p.user_data.em).toEqual([sha256('aluno@exemplo.com')])
    expect(p.user_data.ph).toEqual([sha256('5524981392704')])
    expect(p.user_data.external_id).toEqual([sha256('contact-1')])
    expect(JSON.stringify(p)).not.toContain('exemplo.com')
    expect(JSON.stringify(p)).not.toContain('981392704')
    expect(p.custom_data).toBeUndefined()
  })

  it('venda leva valor e moeda', () => {
    const r = buildCapiEvent(
      { ...event, event_name: 'VendaFechada', event_id: 'deal-1:won', value: 797, currency: 'brl' },
      signals,
      NOW,
    )
    expect(r.ok && r.payload.custom_data).toEqual({ value: 797, currency: 'BRL' })
  })

  it('pula evento velho: a Meta recusaria o lote inteiro', () => {
    const r = buildCapiEvent({ ...event, event_time: '2026-09-01T00:00:00Z' }, signals, NOW)
    expect(r).toEqual({ ok: false, reason: 'evento com mais de 7 dias' })
  })

  it('pula contato que não veio da Meta', () => {
    const r = buildCapiEvent(event, { ...signals, fromMeta: false }, NOW)
    expect(r.ok).toBe(false)
  })

  it('pula quando não há nada para casar', () => {
    const r = buildCapiEvent(
      { ...event, contact_id: null },
      { email: null, phone: null, fbc: null, fbp: 'fb.1.1.1', fromMeta: true },
      NOW,
    )
    expect(r.ok).toBe(false)
  })
})
