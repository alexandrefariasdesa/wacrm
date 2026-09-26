import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { verifyCronSecret } from '@/lib/scheduled-messages/cron-auth'
import { processDueMessages } from '@/lib/scheduled-messages/process'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Chamado a cada minuto pelo pg_cron (via pg_net). Ver migration 046.
export async function GET(request: Request) {
  const denied = verifyCronSecret(request)
  if (denied) return denied

  const admin = supabaseAdmin()
  try {
    const result = await processDueMessages(admin, (accountId, params) =>
      sendMessageToConversation(admin, accountId, params),
    )
    return NextResponse.json(result)
  } catch (err) {
    console.error('[scheduled-cron] falhou:', err)
    return NextResponse.json({ error: 'cron failed' }, { status: 500 })
  }
}
