import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import type { AdLevel, AttributionModel } from '@/lib/ads/types'

/**
 * Os números do painel de anúncios.
 *
 * Rota de servidor (e não uma consulta direta do cliente, como o resto do
 * dashboard faz) porque as três funções SQL da migration 041 são RPC:
 * expor a agregação aqui mantém o navegador longe das tabelas cruas de
 * toque e de negócio, e uma resposta só carrega três consultas.
 *
 * Query params:
 *   from, to      — YYYY-MM-DD (obrigatórios)
 *   level         — ad | campaign | platform  (padrão: ad)
 *   attribution   — first | last              (padrão: first)
 */

export const dynamic = 'force-dynamic'

const LEVELS: AdLevel[] = ['ad', 'campaign', 'platform']
const MODELS: AttributionModel[] = ['first', 'last']

/** YYYY-MM-DD, e uma data que existe de verdade. */
function parseDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  // Rejeita 2026-02-31: o Date "corrige" para 03-03 em silêncio, e a
  // janela consultada deixaria de ser a que o usuário pediu.
  return d.toISOString().slice(0, 10) === value ? value : null
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const url = new URL(request.url)

    const from = parseDate(url.searchParams.get('from'))
    const to = parseDate(url.searchParams.get('to'))
    if (!from || !to) {
      return NextResponse.json(
        { error: 'Informe `from` e `to` no formato YYYY-MM-DD' },
        { status: 400 },
      )
    }
    if (from > to) {
      return NextResponse.json(
        { error: '`from` não pode ser depois de `to`' },
        { status: 400 },
      )
    }

    const levelParam = url.searchParams.get('level') as AdLevel | null
    const level: AdLevel = levelParam && LEVELS.includes(levelParam) ? levelParam : 'ad'

    const modelParam = url.searchParams.get('attribution') as AttributionModel | null
    const attribution: AttributionModel =
      modelParam && MODELS.includes(modelParam) ? modelParam : 'first'

    // As três em paralelo: são independentes e a mais lenta manda no
    // tempo de resposta.
    const [overview, rows, series] = await Promise.all([
      supabase.rpc('ad_overview', {
        p_account_id: accountId,
        p_from: from,
        p_to: to,
        p_attribution: attribution,
      }),
      supabase.rpc('ad_performance', {
        p_account_id: accountId,
        p_from: from,
        p_to: to,
        p_level: level,
        p_attribution: attribution,
      }),
      supabase.rpc('ad_daily_series', {
        p_account_id: accountId,
        p_from: from,
        p_to: to,
        p_attribution: attribution,
      }),
    ])

    const failure = overview.error ?? rows.error ?? series.error
    if (failure) {
      console.error('[ads metrics] RPC falhou:', failure)
      return NextResponse.json(
        { error: 'Não foi possível calcular as métricas' },
        { status: 500 },
      )
    }

    // As funções SQL devolvem NUMERIC, que o PostgREST serializa como
    // string para não perder precisão. Converter aqui evita que a UI faça
    // concatenação onde deveria somar.
    const num = (v: unknown) => Number(v ?? 0)

    return NextResponse.json({
      overview: overview.data?.[0]
        ? {
            ...overview.data[0],
            spend: num(overview.data[0].spend),
            revenue: num(overview.data[0].revenue),
          }
        : null,
      rows: (rows.data ?? []).map((r: Record<string, unknown>) => ({
        ...r,
        spend: num(r.spend),
        revenue: num(r.revenue),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        leads: num(r.leads),
        conversations: num(r.conversations),
        deals_won: num(r.deals_won),
      })),
      series: (series.data ?? []).map((p: Record<string, unknown>) => ({
        day: p.day,
        spend: num(p.spend),
        leads: num(p.leads),
        revenue: num(p.revenue),
      })),
      level,
      attribution,
      from,
      to,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
