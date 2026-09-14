import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { syncAllAdAccounts } from '@/lib/ads/sync'
import { processConversionEvents } from '@/lib/ads/capi'

/**
 * Sync agendado de TODAS as contas de anúncio, de todos os tenants.
 *
 * Feito para rodar de hora em hora (Vercel Cron, GitHub Actions, um
 * pinger qualquer). Autenticação por segredo compartilhado no header
 * `x-cron-secret`, no mesmo formato do cron de automações.
 *
 * De hora em hora e não de minuto em minuto porque as duas plataformas
 * consolidam gasto com atraso: um sync mais frequente gastaria cota para
 * reler o mesmo número.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const expected = process.env.ADS_CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron não configurado' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  // Comparação em tempo constante, e o teste de tamanho antes porque
  // `timingSafeEqual` LANÇA quando os buffers têm tamanhos diferentes.
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  try {
    const results = await syncAllAdAccounts(admin)
    // Depois do sync: a fila da Conversions API precisa do anúncio já
    // espelhado para saber que o contato veio da Meta.
    const conversions = await processConversionEvents(admin)
    return NextResponse.json({
      synced: results.length,
      failed: results.filter((r) => r.error).length,
      results,
      conversions,
    })
  } catch (err) {
    console.error('[ads cron] falhou:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro desconhecido' },
      { status: 500 },
    )
  }
}
