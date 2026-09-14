import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { parseAttributionModel, parseDate, parseLevel } from '@/lib/ads/query-params'

/**
 * O funil por etapa, por criativo (função `ad_stage_funnel`, migration 044).
 *
 * Query params:
 *   from, to      — YYYY-MM-DD (obrigatórios)
 *   pipeline_id   — o funil cujas etapas viram colunas (obrigatório)
 *   level         — ad | adset | campaign | platform  (padrão: ad)
 *   attribution   — first | last                      (padrão: first)
 *
 * Resposta: { stages: [{id, name, position}], cells: [{group_key, stage_id, reached}],
 *            lost: [{group_key, reason, lost}] }
 */

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const url = new URL(request.url)

    const from = parseDate(url.searchParams.get('from'))
    const to = parseDate(url.searchParams.get('to'))
    const pipelineId = url.searchParams.get('pipeline_id') ?? ''
    if (!from || !to || from > to) {
      return NextResponse.json({ error: 'Período inválido' }, { status: 400 })
    }
    if (!UUID.test(pipelineId)) {
      return NextResponse.json({ error: 'Informe `pipeline_id`' }, { status: 400 })
    }

    const level = parseLevel(url.searchParams.get('level'))
    const attribution = parseAttributionModel(url.searchParams.get('attribution'))

    const [stages, cells, lost] = await Promise.all([
      // As etapas vêm da tabela, não da função: um funil sem nenhum lead
      // atribuído ainda precisa mostrar as colunas vazias.
      supabase
        .from('pipeline_stages')
        .select('id, name, position, is_qualification')
        .eq('pipeline_id', pipelineId)
        .order('position', { ascending: true }),
      supabase.rpc('ad_stage_funnel', {
        p_account_id: accountId,
        p_from: from,
        p_to: to,
        p_pipeline_id: pipelineId,
        p_level: level,
        p_attribution: attribution,
      }),
      supabase.rpc('ad_lost_reasons', {
        p_account_id: accountId,
        p_from: from,
        p_to: to,
        p_pipeline_id: pipelineId,
        p_level: level,
        p_attribution: attribution,
      }),
    ])

    const failure = stages.error ?? cells.error ?? lost.error
    if (failure) {
      console.error('[ads funnel] consulta falhou:', failure)
      return NextResponse.json(
        { error: 'Não foi possível calcular o funil' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      stages: stages.data ?? [],
      cells: (cells.data ?? []).map((c: Record<string, unknown>) => ({
        group_key: c.group_key,
        stage_id: c.stage_id,
        reached: Number(c.reached ?? 0),
      })),
      lost: (lost.data ?? []).map((l: Record<string, unknown>) => ({
        group_key: l.group_key,
        reason: l.reason,
        lost: Number(l.lost ?? 0),
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
