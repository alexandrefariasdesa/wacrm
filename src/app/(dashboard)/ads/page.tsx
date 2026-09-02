'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'
import { AdsMetricCards } from '@/components/ads/ads-metric-cards'
import { AdsChart } from '@/components/ads/ads-chart'
import { AdsTable } from '@/components/ads/ads-table'
import { AdAccountsPanel } from '@/components/ads/ad-accounts-panel'
import { TrackingLinksPanel } from '@/components/ads/tracking-links-panel'
import type {
  AdDailyPoint,
  AdLevel,
  AdOverview,
  AdPerformanceRow,
  AttributionModel,
} from '@/lib/ads/types'

type RangeDays = 7 | 30 | 90

/**
 * Painel de anúncios: o que foi investido, o que voltou.
 *
 * Duas ideias governam a tela:
 *
 *   1. Nada aqui é estimado. Cada lead está ligado a um anúncio por um
 *      identificador que a Meta carimbou (CTWA) ou por um código que
 *      atravessou a landing page. Não há modelagem estatística, não há
 *      janela de conversão adivinhada — se a origem não é conhecida, o
 *      contato aparece como orgânico e pronto.
 *
 *   2. O ROAS de janela curta é sempre pessimista, porque a venda demora
 *      mais que o clique. O aviso no topo diz isso em vez de deixar o
 *      usuário concluir sozinho que a mídia não paga.
 */
export default function AdsPage() {
  const t = useTranslations('Ads.page')
  const { defaultCurrency, canEditSettings } = useAuth()
  const searchParams = useSearchParams()

  const [range, setRange] = useState<RangeDays>(30)
  const [level, setLevel] = useState<AdLevel>('ad')
  const [attribution, setAttribution] = useState<AttributionModel>('first')

  const [overview, setOverview] = useState<AdOverview | null>(null)
  const [rows, setRows] = useState<AdPerformanceRow[]>([])
  const [series, setSeries] = useState<AdDailyPoint[]>([])
  const [loading, setLoading] = useState(true)

  // Resultado do OAuth, devolvido pelos callbacks na query string.
  const oauthNotice = useMemo(() => {
    for (const platform of ['meta', 'google'] as const) {
      const status = searchParams.get(platform)
      if (status) {
        return { platform, status, detail: searchParams.get('detail') }
      }
    }
    return null
  }, [searchParams])

  const { from, to } = useMemo(() => {
    const end = new Date()
    const start = new Date(end.getTime() - (range - 1) * 24 * 60 * 60 * 1000)
    const ymd = (d: Date) => d.toISOString().slice(0, 10)
    return { from: ymd(start), to: ymd(end) }
  }, [range])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ from, to, level, attribution })
      const res = await fetch(`/api/ads/metrics?${qs}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json()
      setOverview(json.overview)
      setRows(json.rows ?? [])
      setSeries(json.series ?? [])
    } catch (err) {
      console.error('[ads] falha ao carregar métricas:', err)
      setOverview(null)
      setRows([])
      setSeries([])
    } finally {
      setLoading(false)
    }
  }, [from, to, level, attribution])

  useEffect(() => {
    void load()
  }, [load])

  const ranges: RangeDays[] = [7, 30, 90]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Primeiro x último clique. Fica ao lado do período e não
              escondido em configurações porque trocar o modelo muda TODO
              número da tela — quem lê precisa ver qual está ativo. */}
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {(['first', 'last'] as AttributionModel[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setAttribution(m)}
                title={t(`attributionHint.${m}`)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  attribution === m
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`attribution.${m}`)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {ranges.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  range === r
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('rangeDays', { days: r })}
              </button>
            ))}
          </div>
        </div>
      </div>

      {oauthNotice ? (
        <div
          className={cn(
            'rounded-lg border px-4 py-3 text-sm',
            oauthNotice.status === 'conectado'
              ? 'border-primary/30 bg-primary/10 text-foreground'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {oauthNotice.status === 'conectado'
            ? t('oauthConnected', {
                platform: oauthNotice.platform === 'meta' ? 'Meta' : 'Google Ads',
                count: oauthNotice.detail ?? '?',
              })
            : oauthNotice.status === 'cancelado'
              ? t('oauthCancelled')
              : t('oauthFailed', { detail: oauthNotice.detail ?? '' })}
        </div>
      ) : null}

      <AdsMetricCards
        overview={overview}
        loading={loading}
        currency={defaultCurrency}
      />

      {/* O aviso do ciclo de venda. Fica sempre visível, não só quando o
          ROAS está baixo: um aviso que só aparece na má notícia é lido
          como desculpa. */}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('dateRuleNote')}
      </p>

      <AdsChart series={series} loading={loading} currency={defaultCurrency} />

      <AdsTable
        rows={rows}
        loading={loading}
        level={level}
        onLevelChange={setLevel}
        currency={defaultCurrency}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdAccountsPanel canManage={canEditSettings} />
        <TrackingLinksPanel canManage={canEditSettings} />
      </div>
    </div>
  )
}
