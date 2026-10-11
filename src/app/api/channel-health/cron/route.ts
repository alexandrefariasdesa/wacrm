import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { verifyCronSecret } from '@/lib/scheduled-messages/cron-auth'
import { runChannelWatchdog } from '@/lib/whatsapp/channel-watchdog'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Chamado a cada 2 minutos pelo pg_cron (via pg_net), como o agendador.
// Fica FORA de /api/whatsapp/: o middleware bloqueia esse prefixo sem
// sessão e o cron não tem cookie.
export async function GET(request: Request) {
  const denied = verifyCronSecret(request)
  if (denied) return denied

  try {
    const items = await runChannelWatchdog(supabaseAdmin())
    return NextResponse.json({ ok: true, channels: items })
  } catch (err) {
    console.error('[channel-health-cron] falhou:', err)
    return NextResponse.json({ error: 'cron failed' }, { status: 500 })
  }
}
