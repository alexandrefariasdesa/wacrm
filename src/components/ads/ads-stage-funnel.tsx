'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BadgeCheck, Filter } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency } from '@/lib/currency'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import { cn } from '@/lib/utils'
import type { AdLevel, AdPerformanceRow, AttributionModel } from '@/lib/ads/types'

interface Props {
  rows: AdPerformanceRow[]
  level: AdLevel
  attribution: AttributionModel
  from: string
  to: string
  currency: string
}

interface StageColumn {
  id: string
  name: string
  position: number
  is_qualification: boolean
}

interface PipelineOption {
  id: string
  name: string
  receives_api_leads: boolean
}

/**
 * Funil por etapa, por criativo.
 *
 * A tabela de desempenho responde "quanto custa o lead e o qualificado".
 * Esta responde "ONDE cada criativo vaza": dois anúncios com o mesmo custo
 * por qualificado podem ter um funil que morre na reunião e outro que
 * chega na proposta — e é o segundo que vai virar venda.
 *
 * Cada célula: quantos leads daquele grupo já chegaram à etapa (ou
 * passaram dela), e o custo de cada um. Mesma coorte da coluna de
 * qualificados: leads que chegaram no período, com tudo o que aconteceu
 * com eles até hoje.
 */
export function AdsStageFunnel({ rows, level, attribution, from, to, currency }: Props) {
  const t = useTranslations('Ads.funnel')
  const [pipelines, setPipelines] = useState<PipelineOption[] | null>(null)
  const [pipelineId, setPipelineId] = useState<string>('')
  const [stages, setStages] = useState<StageColumn[]>([])
  const [cells, setCells] = useState<Map<string, Map<string, number>>>(new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    void supabase
      .from('pipelines')
      .select('id, name, receives_api_leads')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        const list = (data ?? []) as PipelineOption[]
        setPipelines(list)
        // O funil que recebe os leads do formulário é, por definição, o
        // funil comercial — é ele que a pessoa quer ver primeiro.
        const preferred = list.find((p) => p.receives_api_leads) ?? list[0]
        if (preferred) setPipelineId(preferred.id)
      })
  }, [])

  useEffect(() => {
    if (!pipelineId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- início de carregamento
    setLoading(true)
    const qs = new URLSearchParams({ from, to, level, attribution, pipeline_id: pipelineId })
    fetch(`/api/ads/funnel?${qs}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => {
        if (cancelled) return
        setStages(json.stages ?? [])
        const map = new Map<string, Map<string, number>>()
        for (const c of json.cells ?? []) {
          if (!map.has(c.group_key)) map.set(c.group_key, new Map())
          map.get(c.group_key)!.set(c.stage_id, c.reached)
        }
        setCells(map)
      })
      .catch((err) => {
        console.error('[ads] falha ao carregar funil:', err)
        if (!cancelled) {
          setStages([])
          setCells(new Map())
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [pipelineId, from, to, level, attribution])

  // Só grupos com lead neste funil. Anúncio que gastou e não trouxe
  // ninguém já aparece (e se destaca) na tabela de desempenho.
  const lines = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.group_key, r]))
    return [...cells.keys()]
      .map((key) => {
        const row = byKey.get(key)
        return {
          key,
          label: row?.label ?? key.replace(/^ext:/, ''),
          campaign: row?.campaign_label ?? null,
          spend: row?.spend ?? 0,
          counts: cells.get(key)!,
        }
      })
      .filter((l) => [...l.counts.values()].some((n) => n > 0))
      .sort((a, b) => b.spend - a.spend)
  }, [rows, cells])

  const hasQualificationStage = stages.some((s) => s.is_qualification)

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {pipelines && pipelines.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Filter className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{t('pipeline')}</span>
            <select
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {pipelines !== null && stages.length > 0 && !hasQualificationStage ? (
        <p className="border-b border-border bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
          {t('noQualificationStage')}
        </p>
      ) : null}

      {pipelines === null || loading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : pipelines.length === 0 || lines.length === 0 ? (
        <div className="p-5">
          <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} icon={Filter} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 280 + stages.length * 130 }}>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-5 py-3 text-left font-medium">{t(`col.${level}`)}</th>
                {stages.map((s) => (
                  <th key={s.id} className="px-4 py-3 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      {s.is_qualification ? (
                        <BadgeCheck className="h-3.5 w-3.5 text-primary" aria-label={t('qualificationStage')} />
                      ) : null}
                      {s.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <p className="truncate font-medium text-foreground">{line.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t('spent', { amount: formatCurrency(line.spend, currency) })}
                      {line.campaign ? ` · ${line.campaign}` : ''}
                    </p>
                  </td>
                  {stages.map((s) => {
                    const n = line.counts.get(s.id) ?? 0
                    return (
                      <td
                        key={s.id}
                        className={cn(
                          'px-4 py-3 text-right tabular-nums',
                          s.is_qualification && 'bg-primary/5',
                        )}
                      >
                        <p className={n > 0 ? 'text-foreground' : 'text-muted-foreground'}>
                          {n.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {n > 0 && line.spend > 0
                            ? t('costEach', { amount: formatCurrency(line.spend / n, currency) })
                            : '—'}
                        </p>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
