'use client'

import { useTranslations } from 'next-intl'
import {
  DollarSign,
  Users,
  Trophy,
  TrendingUp,
  MousePointerClick,
} from 'lucide-react'
import { formatCurrency } from '@/lib/currency'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import type { AdOverview } from '@/lib/ads/types'

interface Props {
  overview: AdOverview | null
  loading: boolean
  currency: string
}

/**
 * Os cinco números do topo.
 *
 * A escolha de quais cinco é o argumento inteiro do painel: investimento,
 * leads, vendas, ROAS e o vazamento do link. Custo por lead e custo por
 * venda ficam de fora daqui de propósito — eles variam demais por
 * criativo, e a média de todos juntos esconde exatamente o anúncio caro
 * que precisa ser cortado. Esses dois vivem na tabela, linha a linha.
 */
export function AdsMetricCards({ overview, loading, currency }: Props) {
  const t = useTranslations('Ads.metrics')

  if (loading || !overview) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  const roas = overview.spend > 0 ? overview.revenue / overview.spend : null
  const totalLeads = overview.attributed_leads + overview.organic_leads
  const attributedShare =
    totalLeads > 0 ? Math.round((overview.attributed_leads / totalLeads) * 100) : 0

  // Quantos dos que clicaram no link realmente mandaram mensagem. É a
  // medida do vazamento entre a landing page e o WhatsApp — o único lugar
  // do funil onde o problema é a PÁGINA, não o anúncio.
  const linkMatchRate =
    overview.link_clicks > 0
      ? Math.round((overview.link_clicks_matched / overview.link_clicks) * 100)
      : null

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <MetricCard
        title={t('spend')}
        value={formatCurrency(overview.spend, currency)}
        icon={DollarSign}
        subtitle={t('spendSubtitle', {
          clicks: overview.clicks.toLocaleString(),
        })}
      />
      <MetricCard
        title={t('leads')}
        value={overview.attributed_leads.toLocaleString()}
        icon={Users}
        subtitle={t('leadsSubtitle', {
          share: attributedShare,
          organic: overview.organic_leads.toLocaleString(),
        })}
      />
      <MetricCard
        title={t('dealsWon')}
        value={overview.deals_won.toLocaleString()}
        icon={Trophy}
        subtitle={formatCurrency(overview.revenue, currency)}
      />
      <MetricCard
        title={t('roas')}
        value={roas === null ? '—' : `${roas.toFixed(2)}x`}
        icon={TrendingUp}
        subtitle={
          roas === null ? t('roasNoSpend') : t('roasSubtitle')
        }
      />
      <MetricCard
        title={t('linkConversion')}
        value={linkMatchRate === null ? '—' : `${linkMatchRate}%`}
        icon={MousePointerClick}
        subtitle={
          linkMatchRate === null
            ? t('linkNoClicks')
            : t('linkSubtitle', {
                matched: overview.link_clicks_matched.toLocaleString(),
                total: overview.link_clicks.toLocaleString(),
              })
        }
      />
    </div>
  )
}
