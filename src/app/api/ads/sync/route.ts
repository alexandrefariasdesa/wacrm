import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { syncAllAdAccounts } from '@/lib/ads/sync'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

/**
 * "Sincronizar agora" — puxa gasto e hierarquia sob demanda.
 *
 * Roda com a service role, e não com o cliente do usuário, porque o sync
 * precisa DECIFRAR os tokens e reescrever `ad_accounts` — operações que a
 * RLS de leitura do painel não cobre. A autorização acontece antes, no
 * `requireRole('admin')`, e o `accountId` da sessão é o único filtro que
 * chega ao sync: nunca vem do corpo da requisição.
 */

export const dynamic = 'force-dynamic'
// Uma conta grande com 7 dias de janela pode levar dezenas de segundos
// entre hierarquia e insights das duas plataformas.
export const maxDuration = 120

/** 4 por hora e por conta. Cada sync são várias chamadas às APIs, que
 *  têm cota por APP — um usuário impaciente clicando sem parar gastaria
 *  a cota de todos os tenants. O cron cobre o caso normal. */
const SYNC_RATE_LIMIT = { limit: 4, windowMs: 60 * 60_000 }

export async function POST() {
  try {
    const { accountId } = await requireRole('admin')

    const rl = checkRateLimit(`ads-sync:${accountId}`, SYNC_RATE_LIMIT)
    if (!rl.success) return rateLimitResponse(rl)

    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const results = await syncAllAdAccounts(admin, { accountId })

    return NextResponse.json({
      results,
      // Uma conta com token vencido não invalida o sync das outras, então
      // a resposta é 200 com o detalhe por conta — a UI mostra o erro na
      // linha da conta que falhou, não como um erro global.
      failed: results.filter((r) => r.error).length,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
