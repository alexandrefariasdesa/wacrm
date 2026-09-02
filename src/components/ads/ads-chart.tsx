'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { LineChart } from 'lucide-react'
import { formatCurrencyShort } from '@/lib/currency'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import type { AdDailyPoint } from '@/lib/ads/types'

interface Props {
  series: AdDailyPoint[]
  loading: boolean
  currency: string
}

// Coordenadas do viewBox; o SVG escala por CSS. Mesmo padrão do gráfico
// de conversas do dashboard, para os dois não parecerem widgets de
// produtos diferentes.
const VB_W = 760
const VB_H = 220
const PAD = { top: 16, right: 48, bottom: 26, left: 52 }

/**
 * Gasto (área) contra receita (linha) e leads (barras discretas).
 *
 * As três séries têm unidades diferentes — dinheiro, dinheiro e
 * contagem — então gasto e receita dividem o eixo da esquerda e leads vai
 * no da direita. Forçar tudo num eixo só faria a curva de leads virar
 * uma linha reta colada no zero sempre que o gasto passasse de alguns
 * milhares, que é o caso normal.
 */
export function AdsChart({ series, loading, currency }: Props) {
  const t = useTranslations('Ads.chart')

  const geom = useMemo(() => {
    if (!series.length) return null

    const innerW = VB_W - PAD.left - PAD.right
    const innerH = VB_H - PAD.top - PAD.bottom

    const maxMoney = Math.max(
      1,
      ...series.map((p) => Math.max(p.spend, p.revenue)),
    )
    const maxLeads = Math.max(1, ...series.map((p) => p.leads))

    const x = (i: number) =>
      PAD.left +
      (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW)
    const yMoney = (v: number) => PAD.top + innerH - (v / maxMoney) * innerH
    const yLeads = (v: number) => PAD.top + innerH - (v / maxLeads) * innerH

    const spendPath = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${yMoney(p.spend)}`)
      .join(' ')
    const spendArea =
      `${spendPath} L${x(series.length - 1)},${PAD.top + innerH} ` +
      `L${x(0)},${PAD.top + innerH} Z`
    const revenuePath = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${yMoney(p.revenue)}`)
      .join(' ')

    return { x, yMoney, yLeads, spendPath, spendArea, revenuePath, maxMoney, maxLeads, innerH }
  }, [series])

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <Legend color="var(--color-primary, #22c55e)" label={t('spend')} />
          <Legend color="#8b5cf6" label={t('revenue')} />
          <Legend color="#94a3b8" label={t('leads')} />
        </div>
      </header>

      <div className="p-5">
        {loading ? (
          <Skeleton className="h-56 w-full" />
        ) : !geom ? (
          <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} icon={LineChart} />
        ) : (
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="h-56 w-full"
            role="img"
            aria-label={t('title')}
          >
            {/* Barras de leads ao fundo: o volume é contexto para as duas
                curvas de dinheiro, não o protagonista. */}
            {series.map((p, i) => {
              const barH = PAD.top + geom.innerH - geom.yLeads(p.leads)
              if (barH <= 0) return null
              const w = Math.max(2, (VB_W - PAD.left - PAD.right) / series.length - 3)
              return (
                <rect
                  key={p.day}
                  x={geom.x(i) - w / 2}
                  y={geom.yLeads(p.leads)}
                  width={w}
                  height={barH}
                  rx={2}
                  className="fill-muted-foreground/25"
                />
              )
            })}

            <path d={geom.spendArea} className="fill-primary/10" />
            <path
              d={geom.spendPath}
              fill="none"
              className="stroke-primary"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            <path
              d={geom.revenuePath}
              fill="none"
              stroke="#8b5cf6"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeDasharray="4 3"
            />

            {/* Só os extremos nos eixos. Rótulo em cada ponto viraria
                papa ilegível numa janela de 90 dias. */}
            <text x={4} y={PAD.top + 4} className="fill-muted-foreground text-[10px]">
              {formatCurrencyShort(geom.maxMoney, currency)}
            </text>
            <text
              x={4}
              y={PAD.top + geom.innerH}
              className="fill-muted-foreground text-[10px]"
            >
              0
            </text>
            <text
              x={VB_W - PAD.right + 6}
              y={PAD.top + 4}
              className="fill-muted-foreground text-[10px]"
            >
              {geom.maxLeads}
            </text>
            <text x={PAD.left} y={VB_H - 6} className="fill-muted-foreground text-[10px]">
              {formatDay(series[0].day)}
            </text>
            <text
              x={VB_W - PAD.right}
              y={VB_H - 6}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {formatDay(series[series.length - 1].day)}
            </text>
          </svg>
        )}
      </div>
    </section>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {label}
    </span>
  )
}

/** "2026-09-02" -> "02/09". */
function formatDay(day: string): string {
  const [, m, d] = day.split('-')
  return `${d}/${m}`
}
