import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { googleOAuthUrl } from '@/lib/ads/google'
import { issueOAuthState, appBaseUrl } from '@/lib/ads/oauth-state'

/** Começa a conexão com o Google Ads. */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await requireRole('admin')

    const clientId = process.env.GOOGLE_ADS_CLIENT_ID
    if (!clientId) {
      return NextResponse.json(
        { error: 'GOOGLE_ADS_CLIENT_ID não configurado no servidor' },
        { status: 503 },
      )
    }

    const state = await issueOAuthState('google')
    const redirectUri = `${appBaseUrl()}/api/ads/oauth/google/callback`

    return NextResponse.redirect(googleOAuthUrl(clientId, redirectUri, state), 302)
  } catch (err) {
    return toErrorResponse(err)
  }
}
