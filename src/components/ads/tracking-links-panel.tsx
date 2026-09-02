'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy, Link2, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import type { TrackingLink } from '@/lib/ads/types'

interface LinkRow extends TrackingLink {
  clicks: number
  matched: number
}

/**
 * Links rastreáveis — o caminho de atribuição para o Google Ads.
 *
 * A tela existe porque a origem NÃO sobrevive ao pulo da landing page
 * para o WhatsApp: querystring, cookie e `Referer` são todos descartados
 * pelo navegador ao abrir o app. O link gerado aqui resolve isso pelo
 * único canal que resta — o texto da mensagem.
 *
 * A coluna que mais importa é "clicou → chamou": ela separa um anúncio
 * ruim (pouco clique) de uma página ruim (muito clique, pouca conversa).
 */
export function TrackingLinksPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations('Ads.links')
  const [links, setLinks] = useState<LinkRow[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    code: '',
    destination_phone: '',
    prefill_text: '',
    platform: 'google' as 'google' | 'meta' | 'other',
  })

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ads/links', { cache: 'no-store' })
      const json = await res.json()
      setLinks(json.links ?? [])
    } catch {
      setLinks([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/ads/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? t('createFailed'))
        return
      }
      setForm({
        name: '',
        code: '',
        destination_phone: '',
        prefill_text: '',
        platform: 'google',
      })
      setCreating(false)
      await load()
    } catch {
      setError(t('createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    await fetch(`/api/ads/links/${id}`, { method: 'DELETE' })
    await load()
  }

  const publicUrl = (code: string) =>
    `${typeof window === 'undefined' ? '' : window.location.origin}/api/track/${code}`

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(publicUrl(code))
      setCopied(code)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // Clipboard negado (contexto sem HTTPS, permissão do navegador).
      // Silencioso de propósito: a URL está visível na linha e dá para
      // selecionar à mão.
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            <Plus className="h-4 w-4" />
            {t('newLink')}
          </Button>
        ) : null}
      </header>

      {creating ? (
        <form
          onSubmit={create}
          className="grid gap-4 border-b border-border bg-muted/30 px-5 py-4 sm:grid-cols-2"
        >
          <div className="space-y-1.5">
            <Label htmlFor="tl-name">{t('form.name')}</Label>
            <Input
              id="tl-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('form.namePlaceholder')}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tl-code">{t('form.code')}</Label>
            <Input
              id="tl-code"
              value={form.code}
              onChange={(e) =>
                setForm({ ...form, code: e.target.value.toLowerCase() })
              }
              placeholder={t('form.codePlaceholder')}
              required
            />
            <p className="text-xs text-muted-foreground">{t('form.codeHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tl-phone">{t('form.phone')}</Label>
            <Input
              id="tl-phone"
              value={form.destination_phone}
              onChange={(e) =>
                setForm({ ...form, destination_phone: e.target.value })
              }
              placeholder="5511999999999"
              required
            />
            <p className="text-xs text-muted-foreground">{t('form.phoneHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tl-text">{t('form.prefill')}</Label>
            <Input
              id="tl-text"
              value={form.prefill_text}
              onChange={(e) => setForm({ ...form, prefill_text: e.target.value })}
              placeholder={t('form.prefillPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('form.prefillHint')}</p>
          </div>

          {error ? (
            <p className="text-sm text-red-400 sm:col-span-2">{error}</p>
          ) : null}

          <div className="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('form.submit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCreating(false)}
            >
              {t('form.cancel')}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="p-5">
        {links === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : links.length === 0 ? (
          <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} icon={Link2} />
        ) : (
          <ul className="space-y-2">
            {links.map((l) => {
              const rate =
                l.clicks > 0 ? Math.round((l.matched / l.clicks) * 100) : null
              return (
                <li
                  key={l.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {l.name}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {publicUrl(l.code)}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 text-xs">
                    <div className="text-right">
                      <p className="tabular-nums text-foreground">
                        {l.matched} / {l.clicks}
                      </p>
                      <p className="text-muted-foreground">
                        {rate === null ? t('noClicks') : t('clickToChat', { rate })}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => copy(l.code)}
                      aria-label={t('copy')}
                    >
                      {copied === l.code ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => remove(l.id)}
                        aria-label={t('remove')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
