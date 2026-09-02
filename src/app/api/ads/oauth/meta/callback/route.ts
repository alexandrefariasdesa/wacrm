import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listMetaAdAccounts,
} from '@/lib/ads/meta'
import { consumeOAuthState, appBaseUrl } from '@/lib/ads/oauth-state'

/**
 * Volta do diálogo da Meta.
 *
 * Troca o `code` por um token de curta duração, troca ESSE por um de
 * longa duração (~60 dias) e conecta todas as contas de anúncio que o
 * token enxerga.
 *
 * Conecta todas em vez de pedir para escolher: quem tem várias contas
 * quase sempre quer ver o gasto somado, e desconectar uma depois é um
 * clique. O caminho de escolher uma a uma continua existindo no fluxo de
 * token manual (`PUT /api/ads/accounts`).
 */

export const dynamic = 'force-dynamic'

/** Volta para a UI com o resultado na query, para a página mostrar. */
function backToSettings(status: string, detail?: string): NextResponse {
  const url = new URL(`${appBaseUrl()}/ads`)
  url.searchParams.set('meta', status)
  if (detail) url.searchParams.set('detail', detail.slice(0, 200))
  return NextResponse.redirect(url, 302)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')

  // Usuário clicou em "Cancelar" no diálogo. Não é falha — volta calado.
  if (denied) return backToSettings('cancelado')

  // O state é conferido ANTES de qualquer coisa cara e antes de tocar no
  // `code`: é justamente o code de um terceiro que não pode ser trocado.
  if (!(await consumeOAuthState(state, 'meta'))) {
    return backToSettings('erro', 'Sessão de autorização inválida ou expirada')
  }
  if (!code) return backToSettings('erro', 'Autorização sem código')

  try {
    // A sessão do usuário chega junto porque o callback é uma navegação
    // do próprio navegador dele — os cookies vêm na requisição.
    const { supabase, accountId, userId } = await requireRole('admin')

    const appId = process.env.META_ADS_APP_ID ?? process.env.META_APP_ID
    const appSecret = process.env.META_ADS_APP_SECRET ?? process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      return backToSettings('erro', 'App da Meta não configurado no servidor')
    }

    const redirectUri = `${appBaseUrl()}/api/ads/oauth/meta/callback`
    const shortLived = await exchangeCodeForToken(code, appId, appSecret, redirectUri)
    const { accessToken, expiresInSeconds } = await exchangeForLongLivedToken(
      shortLived,
      appId,
      appSecret,
    )

    const adAccounts = await listMetaAdAccounts(accessToken)
    if (!adAccounts.length) {
      return backToSettings(
        'erro',
        'Nenhuma conta de anúncio encontrada para esse usuário',
      )
    }

    const expiresAt = expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null

    const { error } = await supabase.from('ad_accounts').upsert(
      adAccounts.map((a) => ({
        account_id: accountId,
        user_id: userId,
        platform: 'meta' as const,
        external_id: a.id,
        name: a.name,
        currency: a.currency ?? 'BRL',
        timezone: a.timezone_name ?? null,
        access_token: encrypt(accessToken),
        token_expires_at: expiresAt,
        status: 'connected' as const,
        sync_error: null,
      })),
      { onConflict: 'account_id,platform,external_id' },
    )

    if (error) {
      console.error('[ads oauth meta] falha ao gravar contas:', error)
      return backToSettings('erro', 'Falha ao salvar as contas conectadas')
    }

    return backToSettings('conectado', String(adAccounts.length))
  } catch (err) {
    console.error('[ads oauth meta] falhou:', err)
    return backToSettings(
      'erro',
      err instanceof Error ? err.message : 'Erro desconhecido',
    )
  }
}
