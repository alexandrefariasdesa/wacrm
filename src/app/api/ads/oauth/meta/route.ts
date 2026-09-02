import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { metaOAuthUrl } from '@/lib/ads/meta'
import { issueOAuthState, appBaseUrl } from '@/lib/ads/oauth-state'

/** Começa a conexão com a Meta: emite o state e redireciona ao diálogo. */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await requireRole('admin')

    const appId = process.env.META_ADS_APP_ID ?? process.env.META_APP_ID
    if (!appId) {
      return NextResponse.json(
        { error: 'META_ADS_APP_ID não configurado no servidor' },
        { status: 503 },
      )
    }

    const state = await issueOAuthState('meta')
    const redirectUri = `${appBaseUrl()}/api/ads/oauth/meta/callback`

    return NextResponse.redirect(metaOAuthUrl(appId, redirectUri, state), 302)
  } catch (err) {
    return toErrorResponse(err)
  }
}
