import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { META_API_BASE } from './meta'

/**
 * Conversions API da Meta: devolve à Meta o que só o CRM sabe.
 *
 * A landing page manda `Lead` para o pixel no momento do cadastro. O que
 * acontece depois — o vendedor marcar como qualificado, o negócio fechar —
 * a Meta nunca veria. Sem esse retorno ela otimiza a campanha para quem
 * PREENCHE formulário; com ele, dá para otimizar para quem QUALIFICA (um
 * evento personalizado vira conversão personalizada na campanha).
 *
 * Fluxo: o trigger da migration 044 põe o evento em `conversion_events`
 * quando `deals.qualified_at` / `deals.won_at` são carimbados; o cron
 * (`/api/ads/cron`) chama `processConversionEvents`, que envia em lote.
 *
 * `action_source: 'system_generated'` e não `website`: o evento nasce no
 * CRM, dias depois da visita, sem navegador — declarar `website` exigiria
 * IP e user agent daquele momento, que não existem mais.
 */

/** A Meta recusa evento com `event_time` mais velho que isso. */
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 5
const BATCH = 200

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** E-mail como a Meta pede antes do hash: sem espaço, minúsculo. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const clean = (email ?? '').trim().toLowerCase()
  return clean.includes('@') ? clean : null
}

/** Telefone como a Meta pede antes do hash: só dígitos, com o país. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 10 ? digits : null
}

/**
 * O `fbc` do clique. O cookie `_fbc` da página vence; sem ele, monta a
 * partir do `fbclid` no formato documentado (`fb.1.<ms do clique>.<fbclid>`).
 */
export function buildFbc(
  fbc: string | null | undefined,
  fbclid: string | null | undefined,
  clickedAt: string | null | undefined,
): string | null {
  if (fbc) return fbc
  if (!fbclid) return null
  const ms = clickedAt ? new Date(clickedAt).getTime() : NaN
  return Number.isFinite(ms) ? `fb.1.${ms}.${fbclid}` : null
}

export interface PendingEvent {
  id: string
  event_name: string
  event_id: string
  event_time: string
  value: number | null
  currency: string | null
  contact_id: string | null
}

export interface MatchSignals {
  email: string | null
  phone: string | null
  fbc: string | null
  fbp: string | null
  /** Veio de anúncio da Meta? Sem isso o evento não é enviado. */
  fromMeta: boolean
}

export type BuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string }

/** Um evento da fila vira um item do `data[]` da Conversions API. */
export function buildCapiEvent(
  event: PendingEvent,
  signals: MatchSignals,
  now: number = Date.now(),
): BuildResult {
  const time = new Date(event.event_time).getTime()
  if (!Number.isFinite(time) || now - time > MAX_EVENT_AGE_MS) {
    // Acontece ao marcar a etapa de qualificação num funil antigo: o
    // backfill carimba negócios de semanas atrás. A Meta rejeitaria o lote
    // inteiro por causa de um evento velho.
    return { ok: false, reason: 'evento com mais de 7 dias' }
  }
  if (!signals.fromMeta) {
    return { ok: false, reason: 'contato sem origem em anúncio da Meta' }
  }

  const em = normalizeEmail(signals.email)
  const ph = normalizePhone(signals.phone)
  const userData: Record<string, unknown> = {}
  if (em) userData.em = [sha256(em)]
  if (ph) userData.ph = [sha256(ph)]
  if (event.contact_id) userData.external_id = [sha256(event.contact_id)]
  if (signals.fbc) userData.fbc = signals.fbc
  if (signals.fbp) userData.fbp = signals.fbp
  if (!em && !ph && !signals.fbc) {
    return { ok: false, reason: 'sem e-mail, telefone ou fbc para casar' }
  }

  const payload: Record<string, unknown> = {
    event_name: event.event_name,
    event_time: Math.floor(time / 1000),
    event_id: event.event_id,
    action_source: 'system_generated',
    user_data: userData,
  }
  if (event.value !== null && event.value !== undefined && Number(event.value) > 0) {
    payload.custom_data = {
      value: Number(event.value),
      currency: (event.currency ?? 'BRL').toUpperCase(),
    }
  }
  return { ok: true, payload }
}

interface QueueRow extends PendingEvent {
  ad_account_id: string
  attempts: number
}

interface AdAccountRow {
  id: string
  access_token: string | null
  capi_dataset_id: string | null
  capi_test_event_code: string | null
  capi_enabled: boolean
}

export interface CapiRunResult {
  sent: number
  skipped: number
  failed: number
}

/** Esvazia a fila. Nunca lança: erro de envio vira `failed` com o motivo. */
export async function processConversionEvents(db: SupabaseClient): Promise<CapiRunResult> {
  const result: CapiRunResult = { sent: 0, skipped: 0, failed: 0 }

  const { data: queue, error } = await db
    .from('conversion_events')
    .select('id, ad_account_id, event_name, event_id, event_time, value, currency, contact_id, attempts')
    .in('status', ['pending', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(BATCH)
  if (error) {
    console.error('[capi] falha ao ler a fila:', error)
    return result
  }
  if (!queue?.length) return result

  const rows = queue as QueueRow[]
  const accountIds = [...new Set(rows.map((r) => r.ad_account_id))]
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[]

  const [{ data: accounts }, { data: contacts }, { data: touches }] = await Promise.all([
    db
      .from('ad_accounts')
      .select('id, access_token, capi_dataset_id, capi_test_event_code, capi_enabled')
      .in('id', accountIds),
    contactIds.length
      ? db.from('contacts').select('id, email, phone').in('id', contactIds)
      : Promise.resolve({ data: [] as { id: string; email: string | null; phone: string }[] }),
    contactIds.length
      ? db
          .from('attribution_touches')
          .select('contact_id, platform, occurred_at, ad_click:ad_clicks(fbc, fbp, fbclid, created_at)')
          .in('contact_id', contactIds)
          .order('occurred_at', { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
  ])

  const accountById = new Map((accounts as AdAccountRow[] | null ?? []).map((a) => [a.id, a]))
  const contactById = new Map(
    ((contacts ?? []) as { id: string; email: string | null; phone: string }[]).map((c) => [c.id, c]),
  )

  // Sinais por contato: o toque mais recente da Meta que tenha cookie.
  const signalsByContact = new Map<string, { fromMeta: boolean; fbc: string | null; fbp: string | null }>()
  for (const raw of (touches ?? []) as {
    contact_id: string
    platform: string
    ad_click: { fbc: string | null; fbp: string | null; fbclid: string | null; created_at: string } | null
  }[]) {
    if (raw.platform !== 'meta') continue
    const current = signalsByContact.get(raw.contact_id)
    const fbc = buildFbc(raw.ad_click?.fbc, raw.ad_click?.fbclid, raw.ad_click?.created_at)
    const fbp = raw.ad_click?.fbp ?? null
    if (!current) {
      signalsByContact.set(raw.contact_id, { fromMeta: true, fbc, fbp })
    } else {
      current.fbc ??= fbc
      current.fbp ??= fbp
    }
  }

  const markSkipped = async (id: string, reason: string) => {
    await db.from('conversion_events').update({ status: 'skipped', last_error: reason }).eq('id', id)
    result.skipped++
  }

  for (const adAccountId of accountIds) {
    const account = accountById.get(adAccountId)
    const group = rows.filter((r) => r.ad_account_id === adAccountId)

    if (!account?.capi_enabled || !account.capi_dataset_id || !account.access_token) {
      for (const r of group) await markSkipped(r.id, 'Conversions API desligada ou sem pixel/token')
      continue
    }

    const ready: { row: QueueRow; payload: Record<string, unknown> }[] = []
    for (const row of group) {
      const contact = row.contact_id ? contactById.get(row.contact_id) : undefined
      const sig = row.contact_id ? signalsByContact.get(row.contact_id) : undefined
      const built = buildCapiEvent(row, {
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
        fbc: sig?.fbc ?? null,
        fbp: sig?.fbp ?? null,
        fromMeta: Boolean(sig?.fromMeta),
      })
      if (built.ok) ready.push({ row, payload: built.payload })
      else await markSkipped(row.id, built.reason)
    }
    if (!ready.length) continue

    const body: Record<string, unknown> = { data: ready.map((r) => r.payload) }
    if (account.capi_test_event_code) body.test_event_code = account.capi_test_event_code

    let failure: string | null = null
    try {
      const res = await fetch(
        `${META_API_BASE}/${encodeURIComponent(account.capi_dataset_id)}/events?access_token=${encodeURIComponent(decrypt(account.access_token))}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        failure = `HTTP ${res.status}: ${json.error?.message ?? 'erro da Meta'}`.slice(0, 500)
      }
    } catch (err) {
      failure = (err instanceof Error ? err.message : 'falha de rede').slice(0, 500)
    }

    for (const { row } of ready) {
      if (failure) {
        await db
          .from('conversion_events')
          .update({ status: 'failed', attempts: row.attempts + 1, last_error: failure })
          .eq('id', row.id)
        result.failed++
      } else {
        await db
          .from('conversion_events')
          .update({
            status: 'sent',
            attempts: row.attempts + 1,
            last_error: null,
            sent_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        result.sent++
      }
    }
    if (failure) console.error(`[capi] conta ${adAccountId}: ${failure}`)
  }

  return result
}
