'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle,
  ChevronDown,
  Megaphone,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import { cn } from '@/lib/utils'
import type { AdAccount } from '@/lib/ads/types'

/**
 * Conexão das contas de anúncio.
 *
 * Só admin+ vê os botões de ação — a policy de 040 já barraria a
 * escrita, mas um botão que sempre falha é pior que um botão ausente.
 */
export function AdAccountsPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations('Ads.accounts')
  const [accounts, setAccounts] = useState<AdAccount[] | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ads/accounts', { cache: 'no-store' })
      const json = await res.json()
      setAccounts(json.accounts ?? [])
    } catch {
      setAccounts([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sync = async () => {
    setSyncing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/ads/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMessage(json.error ?? t('syncFailed'))
      } else {
        setMessage(
          json.failed > 0
            ? t('syncPartial', { failed: json.failed })
            : t('syncDone'),
        )
        await load()
      }
    } catch {
      setMessage(t('syncFailed'))
    } finally {
      setSyncing(false)
    }
  }

  const disconnect = async (id: string) => {
    await fetch(`/api/ads/accounts/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Base UI usa `render` no lugar de `asChild`. Precisa ser um
                <a> de verdade (e não fetch): o OAuth é uma navegação de
                topo — a plataforma não autoriza dentro de XHR. */}
            <Button
              variant="outline"
              size="sm"
              render={<a href="/api/ads/oauth/meta" />}
            >
              <Megaphone className="h-4 w-4" />
              {t('connectMeta')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              render={<a href="/api/ads/oauth/google" />}
            >
              <Search className="h-4 w-4" />
              {t('connectGoogle')}
            </Button>
            <Button size="sm" onClick={sync} disabled={syncing || !accounts?.length}>
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t('syncNow')}
            </Button>
          </div>
        ) : null}
      </header>

      {message ? (
        <p className="border-b border-border bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}

      <div className="p-5">
        {accounts === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} icon={Plug} />
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  {a.platform === 'meta' ? (
                    <Megaphone className="h-4 w-4 shrink-0 text-[#0866FF]" />
                  ) : (
                    <Search className="h-4 w-4 shrink-0 text-[#EA4335]" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {a.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.external_id} · {a.currency}
                      {a.last_synced_at
                        ? ` · ${t('lastSync', {
                            when: new Date(a.last_synced_at).toLocaleString(),
                          })}`
                        : ` · ${t('neverSynced')}`}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {a.sync_error ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-red-400"
                      // O erro cru da plataforma no title: é ele que diz
                      // se o token venceu ou se falta permissão, e sem
                      // ele o usuário só sabe que "deu erro".
                      title={a.sync_error}
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t('error')}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'text-xs',
                        a.status === 'connected'
                          ? 'text-primary'
                          : 'text-muted-foreground',
                      )}
                    >
                      {t(`status.${a.status}`)}
                    </span>
                  )}
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => disconnect(a.id)}
                      aria-label={t('disconnect')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
              {a.platform === 'meta' && canManage ? (
                <CapiSettings account={a} onSaved={load} />
              ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/**
 * Conversions API da conta: para onde vão "lead qualificado" e "venda".
 *
 * Fechado por padrão — é configuração de uma vez só, e aberto empurraria a
 * lista de contas para baixo da dobra.
 */
function CapiSettings({ account, onSaved }: { account: AdAccount; onSaved: () => void }) {
  const t = useTranslations('Ads.capi')
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(account.capi_enabled)
  const [dataset, setDataset] = useState(account.capi_dataset_id ?? '')
  const [qualifiedEvent, setQualifiedEvent] = useState(account.capi_qualified_event)
  const [wonEvent, setWonEvent] = useState(account.capi_won_event)
  const [testCode, setTestCode] = useState(account.capi_test_event_code ?? '')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const res = await fetch(`/api/ads/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capi_dataset_id: dataset,
          capi_qualified_event: qualifiedEvent,
          capi_won_event: wonEvent,
          capi_test_event_code: testCode,
          capi_enabled: enabled,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFeedback(json.error ?? t('saveFailed'))
      } else {
        setFeedback(t('saved'))
        onSaved()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>
          {t('title')} · {account.capi_enabled ? t('on') : t('off')}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="grid gap-3 px-4 pb-4 text-xs">
          <p className="text-muted-foreground">{t('description')}</p>
          <label className="flex items-center justify-between gap-3">
            <span className="text-foreground">{t('enabled')}</span>
            <Switch checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} />
          </label>
          <label className="grid gap-1">
            <span className="text-foreground">{t('dataset')}</span>
            <Input
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              placeholder="1926024384554770"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-foreground">{t('qualifiedEvent')}</span>
              <Input value={qualifiedEvent} onChange={(e) => setQualifiedEvent(e.target.value)} autoComplete="off" />
            </label>
            <label className="grid gap-1">
              <span className="text-foreground">{t('wonEvent')}</span>
              <Input value={wonEvent} onChange={(e) => setWonEvent(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <p className="text-muted-foreground">{t('eventNamesHint')}</p>
          <label className="grid gap-1">
            <span className="text-foreground">{t('testCode')}</span>
            <Input
              value={testCode}
              onChange={(e) => setTestCode(e.target.value)}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              placeholder="TEST12345"
            />
            <span className="text-muted-foreground">{t('testCodeHint')}</span>
          </label>
          <div className="flex items-center justify-end gap-3">
            {feedback ? <span className="text-muted-foreground">{feedback}</span> : null}
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
