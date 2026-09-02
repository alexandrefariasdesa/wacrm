import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { exchangeGoogleCode, listGoogleAdsAccounts } from '@/lib/ads/google'
import { consumeOAuthState, appBaseUrl } from '@/lib/ads/oauth-state'

/**
 * Volta do consentimento do Google.
 *
 * Guarda o REFRESH token (cifrado) — o access token dura uma hora e é
 * renovado a cada sync. Sem refresh token a conexão morre sozinha na hora
 * seguinte, e é por isso que a URL de autorização pede
 * `access_type=offline` + `prompt=consent`.
 */

export const dynamic = 'force-dynamic'

function backToAds(status: string, detail?: string): NextResponse {
  const url = new URL(`${appBaseUrl()}/ads`)
  url.searchParams.set('google', status)
  if (detail) url.searchParams.set('detail', detail.slice(0, 200))
  return NextResponse.redirect(url, 302)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')

  if (denied) return backToAds('cancelado')
  if (!(await consumeOAuthState(state, 'google'))) {
    return backToAds('erro', 'Sessão de autorização inválida ou expirada')
  }
  if (!code) return backToAds('erro', 'Autorização sem código')

  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const clientId = process.env.GOOGLE_ADS_CLIENT_ID
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
    if (!clientId || !clientSecret || !developerToken) {
      return backToAds('erro', 'Google Ads não configurado no servidor')
    }

    const redirectUri = `${appBaseUrl()}/api/ads/oauth/google/callback`
    const { accessToken, refreshToken, expiresInSeconds } = await exchangeGoogleCode(
      code,
      clientId,
      clientSecret,
      redirectUri,
    )

    if (!refreshToken) {
      // Acontece quando o Google já tinha um consentimento vivo e ignorou
      // o `prompt=consent` — normalmente porque a conta foi autorizada
      // antes e o app segue autorizado. Sem refresh token o sync não
      // sobrevive à primeira hora, então é melhor falhar aqui e mandar o
      // usuário revogar do que "conectar" algo que morre sozinho.
      return backToAds(
        'erro',
        'O Google não devolveu refresh token. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.',
      )
    }

    const customers = await listGoogleAdsAccounts(accessToken, developerToken)
    // MCC não veicula anúncio: conectar uma geraria uma conta que
    // sincroniza zero e polui a lista.
    const usable = customers.filter((c) => !c.manager)
    if (!usable.length) {
      return backToAds('erro', 'Nenhuma conta de anúncio acessível encontrada')
    }

    // Quando o acesso vem por uma gestora, a API exige `login-customer-id`
    // em toda chamada — sem ele o Google responde um "customer not found"
    // que não explica nada.
    const manager = customers.find((c) => c.manager) ?? null

    const { error } = await supabase.from('ad_accounts').upsert(
      usable.map((c) => ({
        account_id: accountId,
        user_id: userId,
        platform: 'google' as const,
        external_id: c.id,
        name: c.descriptiveName,
        currency: c.currencyCode,
        timezone: c.timeZone,
        login_customer_id: manager?.id ?? null,
        access_token: encrypt(accessToken),
        refresh_token: encrypt(refreshToken),
        token_expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        status: 'connected' as const,
        sync_error: null,
      })),
      { onConflict: 'account_id,platform,external_id' },
    )

    if (error) {
      console.error('[ads oauth google] falha ao gravar contas:', error)
      return backToAds('erro', 'Falha ao salvar as contas conectadas')
    }

    return backToAds('conectado', String(usable.length))
  } catch (err) {
    console.error('[ads oauth google] falhou:', err)
    return backToAds('erro', err instanceof Error ? err.message : 'Erro desconhecido')
  }
}
