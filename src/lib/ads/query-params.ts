import type { AdLevel, AttributionModel } from './types'

/** Parâmetros comuns às rotas do painel de anúncios. */

export const AD_LEVELS: AdLevel[] = ['ad', 'adset', 'campaign', 'platform']
export const ATTRIBUTION_MODELS: AttributionModel[] = ['first', 'last']

/** YYYY-MM-DD, e uma data que existe de verdade. */
export function parseDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  // Rejeita 2026-02-31: o Date "corrige" para 03-03 em silêncio, e a
  // janela consultada deixaria de ser a que o usuário pediu.
  return d.toISOString().slice(0, 10) === value ? value : null
}

export function parseLevel(value: string | null): AdLevel {
  return value && (AD_LEVELS as string[]).includes(value) ? (value as AdLevel) : 'ad'
}

export function parseAttributionModel(value: string | null): AttributionModel {
  return value && (ATTRIBUTION_MODELS as string[]).includes(value)
    ? (value as AttributionModel)
    : 'first'
}
