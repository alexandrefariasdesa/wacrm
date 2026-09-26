import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { verifyCronSecret } from '@/lib/scheduled-messages/cron-auth'
import { drainAzimuteEvents } from '@/lib/azimute/drain'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Chamado a cada minuto pelo pg_cron (via pg_net). Ver migration 047.
// Fica FORA de /api/whatsapp/: o middleware bloqueia esse prefixo sem sessão e o cron não tem cookie.
export async function GET(request: Request) {
  const denied = verifyCronSecret(request)
  if (denied) return denied

  const url = process.env.AZIMUTE_CRM_URL
  // Sem URL configurada, não reclama a fila: os eventos esperam até a configuração existir.
  if (!url) return NextResponse.json({ error: 'AZIMUTE_CRM_URL não configurada' }, { status: 503 })

  try {
    return NextResponse.json(await drainAzimuteEvents(supabaseAdmin(), url))
  } catch (err) {
    console.error('[azimute-cron] falhou:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'cron failed' }, { status: 500 })
  }
}
