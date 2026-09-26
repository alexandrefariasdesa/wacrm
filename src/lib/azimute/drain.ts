import type { SupabaseClient } from '@supabase/supabase-js'
import { buildQualifiedBody } from './build-body'

export const RETRY_DELAYS_MIN = [1, 5, 15, 60]
export const MAX_ATTEMPTS = 5
const BATCH = 20
const TIMEOUT_MS = 10_000

interface EventRow {
  id: string
  contact_id: string | null
  occurred_at: string
  attempts: number
}

export interface DrainResult {
  claimed: number
  sent: number
  skipped: number
  retried: number
  failed: number
}

/** Tira a URL (que carrega a chave) de qualquer texto que vá para o banco. */
function scrub(text: string, url: string) {
  return text.split(url).join('[url]').slice(0, 500)
}

export async function drainAzimuteEvents(
  db: SupabaseClient,
  url: string,
  fetchFn: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): Promise<DrainResult> {
  const { data, error } = await db.rpc('claim_azimute_events', { batch: BATCH })
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as EventRow[]
  const out: DrainResult = { claimed: rows.length, sent: 0, skipped: 0, retried: 0, failed: 0 }

  for (const row of rows) {
    const now = clock()
    const setStatus = async (patch: Record<string, unknown>) => {
      const { error: upErr } = await db
        .from('azimute_events')
        .update(patch)
        .eq('id', row.id)
        .eq('status', 'sending')
      if (upErr) console.error('[azimute] update falhou', row.id, upErr.message)
    }

    let phone: string | null = null
    if (row.contact_id) {
      const { data: contact } = await db
        .from('contacts')
        .select('phone')
        .eq('id', row.contact_id)
        .maybeSingle()
      phone = (contact as { phone: string | null } | null)?.phone ?? null
    }
    const body = buildQualifiedBody({ phone, occurredAt: row.occurred_at })
    if (!body) {
      await setStatus({ status: 'skipped', last_error: 'contato sem telefone' })
      out.skipped += 1
      continue
    }

    let reason: string
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) {
        await setStatus({ status: 'sent', sent_at: now.toISOString(), last_error: null })
        out.sent += 1
        continue
      }
      const text = scrub(await res.text().catch(() => ''), url)
      if (res.status === 404 || res.status === 400) {
        // O Azimute respondeu de propósito (contato desconhecido / corpo inválido): retentar não muda nada.
        await setStatus({ status: 'skipped', last_error: `HTTP ${res.status}: ${text}` })
        out.skipped += 1
        continue
      }
      reason = `HTTP ${res.status}: ${text}`
    } catch (err) {
      reason = scrub(err instanceof Error ? err.message : String(err), url)
    }

    if (row.attempts < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_MIN[Math.min(row.attempts - 1, RETRY_DELAYS_MIN.length - 1)]
      await setStatus({
        status: 'pending',
        last_error: reason,
        next_attempt_at: new Date(now.getTime() + delay * 60_000).toISOString(),
      })
      out.retried += 1
    } else {
      await setStatus({ status: 'failed', last_error: reason })
      out.failed += 1
    }
  }
  return out
}
