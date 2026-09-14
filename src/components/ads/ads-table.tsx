'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUpDown, BarChart3, Megaphone, Search } from 'lucide-react'
import { formatCurrency } from '@/lib/currency'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import { cn } from '@/lib/utils'
import { deriveMetrics, type AdLevel, type AdPerformanceRow } from '@/lib/ads/types'

interface Props {
  rows: AdPerformanceRow[]
  loading: boolean
  level: AdLevel
  onLevelChange: (level: AdLevel) => void
  currency: string
}

type SortKey =
  | 'spend'
  | 'leads'
  | 'qualified'
  | 'cpql'
  | 'qualificationRate'
  | 'deals_won'
  | 'revenue'
  | 'cpl'
  | 'cpa'
  | 'roas'

/**
 * A tabela por anúncio / conjunto / campanha / plataforma.
 *
 * Ordenação padrão por gasto: a pergunta que se faz abrindo esta tela é
 * "para onde está indo o dinheiro", e só depois "o que ele trouxe".
 *
 * Métricas derivadas (CPL, CPA, ROAS) são calculadas no cliente, a partir
 * dos totais que vieram do SQL. Não é duplicação de lógica — é a mesma
 * função `deriveMetrics`, e mantê-la fora do SQL é o que faz a divisão
 * por zero virar "—" em vez de `Infinity` no meio de uma tabela.
 */
export function AdsTable({ rows, loading, level, onLevelChange, currency }: Props) {
  const t = useTranslations('Ads.table')
  const [sortKey, setSortKey] = useState<SortKey>('spend')
  const [desc, setDesc] = useState(true)

  const enriched = useMemo(
    () => rows.map((r) => ({ ...r, ...deriveMetrics(r) })),
    [rows],
  )

  const sorted = useMemo(() => {
    const copy = [...enriched]
    copy.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // `null` é "não dá para calcular" (sem lead, sem gasto). Vai sempre
      // para o fim, nas duas direções: uma linha sem CPL não é a "mais
      // barata", e deixá-la subir no topo ao ordenar crescente esconderia
      // o anúncio que a pessoa está procurando.
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return desc ? Number(bv) - Number(av) : Number(av) - Number(bv)
    })
    return copy
  }, [enriched, sortKey, desc])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setDesc((d) => !d)
    else {
      setSortKey(key)
      setDesc(true)
    }
  }

  const levels: AdLevel[] = ['ad', 'adset', 'campaign', 'platform']

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => onLevelChange(l)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                level === l
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`level.${l}`)}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="p-5">
          <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} icon={BarChart3} />
        </div>
      ) : (
        // A tabela tem 11 colunas numéricas e não cabe em tela de celular.
        // O scroll fica NESTE contêiner e não no body: uma página que
        // rola de lado inteira é muito pior que uma tabela que rola.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-5 py-3 text-left font-medium">{t('col.name')}</th>
                <SortableTh label={t('col.spend')} active={sortKey === 'spend'} desc={desc} onClick={() => toggleSort('spend')} />
                <SortableTh label={t('col.leads')} active={sortKey === 'leads'} desc={desc} onClick={() => toggleSort('leads')} />
                <SortableTh label={t('col.cpl')} active={sortKey === 'cpl'} desc={desc} onClick={() => toggleSort('cpl')} />
                <SortableTh label={t('col.qualified')} active={sortKey === 'qualified'} desc={desc} onClick={() => toggleSort('qualified')} />
                <SortableTh label={t('col.qualificationRate')} active={sortKey === 'qualificationRate'} desc={desc} onClick={() => toggleSort('qualificationRate')} />
                <SortableTh label={t('col.cpql')} active={sortKey === 'cpql'} desc={desc} onClick={() => toggleSort('cpql')} />
                <SortableTh label={t('col.dealsWon')} active={sortKey === 'deals_won'} desc={desc} onClick={() => toggleSort('deals_won')} />
                <SortableTh label={t('col.cpa')} active={sortKey === 'cpa'} desc={desc} onClick={() => toggleSort('cpa')} />
                <SortableTh label={t('col.revenue')} active={sortKey === 'revenue'} desc={desc} onClick={() => toggleSort('revenue')} />
                <SortableTh label={t('col.roas')} active={sortKey === 'roas'} desc={desc} onClick={() => toggleSort('roas')} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.group_key}
                  className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <PlatformIcon platform={row.platform} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {row.label}
                        </p>
                        {row.campaign_label ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {row.campaign_label}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <Num>{formatCurrency(row.spend, currency)}</Num>
                  <Num>{row.leads.toLocaleString()}</Num>
                  <Num muted={row.cpl === null}>
                    {row.cpl === null ? '—' : formatCurrency(row.cpl, currency)}
                  </Num>
                  <Num>{row.qualified.toLocaleString()}</Num>
                  <Num muted={row.qualificationRate === null}>
                    {row.qualificationRate === null
                      ? '—'
                      : `${Math.round(row.qualificationRate * 100)}%`}
                  </Num>
                  {/* O número que decide o teste de criativo: lead barato
                      que ninguém qualifica é o anúncio mais caro da conta. */}
                  <Num muted={row.cpql === null}>
                    {row.cpql === null ? '—' : formatCurrency(row.cpql, currency)}
                  </Num>
                  <Num>{row.deals_won.toLocaleString()}</Num>
                  <Num muted={row.cpa === null}>
                    {row.cpa === null ? '—' : formatCurrency(row.cpa, currency)}
                  </Num>
                  <Num>{formatCurrency(row.revenue, currency)}</Num>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {row.roas === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          'font-medium',
                          // 1x é o ponto de equilíbrio bruto: abaixo
                          // disso o anúncio devolve menos do que custou.
                          row.roas >= 1 ? 'text-primary' : 'text-red-400',
                        )}
                      >
                        {row.roas.toFixed(2)}x
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function SortableTh({
  label,
  active,
  desc,
  onClick,
}: {
  label: string
  active: boolean
  desc: boolean
  onClick: () => void
}) {
  return (
    // `aria-sort` vai no <th>, não no <button>: o atributo descreve a
    // COLUNA, e a role implícita de button não o suporta — num leitor de
    // tela ele seria simplesmente ignorado ali.
    <th
      className="px-4 py-3 text-right font-medium"
      aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        <ArrowUpDown className="h-3 w-3" aria-hidden />
      </button>
    </th>
  )
}

function Num({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <td
      className={cn(
        'px-4 py-3 text-right tabular-nums',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {children}
    </td>
  )
}

function PlatformIcon({ platform }: { platform: string }) {
  // lucide-react dropped its brand icons, so these are the closest
  // neutral stand-ins, kept colour-coded to each platform.
  if (platform === 'meta') {
    return <Megaphone className="h-4 w-4 shrink-0 text-[#0866FF]" aria-hidden />
  }
  if (platform === 'google') {
    return <Search className="h-4 w-4 shrink-0 text-[#EA4335]" aria-hidden />
  }
  return <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}
