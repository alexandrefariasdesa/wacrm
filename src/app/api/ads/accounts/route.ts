import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { listMetaAdAccounts, MetaAdsError } from '@/lib/ads/meta'
import { listGoogleAdsAccounts, GoogleAdsError } from '@/lib/ads/google'

/**
 * Contas de anúncio conectadas.
 *
 * GET  — lista (qualquer membro; os tokens NUNCA saem daqui).
 * POST — conecta uma conta (admin+).
 *
 * O POST aceita dois caminhos:
 *   - `{ platform, external_id, name, ... , access_token }` — token
 *     colado à mão (System User da Meta, por exemplo). Serve para quem
 *     não quer passar pelo OAuth ou está testando.
 *   - o callback do OAuth chama internamente a mesma lógica.
 */

export const dynamic = 'force-dynamic'

/** Colunas seguras. `access_token` / `refresh_token` ficam de fora por
 *  desenho — não há motivo para um token cifrado trafegar até o browser,
 *  e uma vez na resposta ele acabaria em log de proxy e em devtools. */
const SAFE_COLUMNS =
  'id, platform, external_id, name, currency, timezone, login_customer_id, status, last_synced_at, sync_error, created_at'

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ad_accounts')
      .select(SAFE_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[ads accounts] falha ao listar:', error)
      return NextResponse.json({ error: 'Falha ao listar contas' }, { status: 500 })
    }
    return NextResponse.json({ accounts: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface ConnectBody {
  platform?: 'meta' | 'google'
  external_id?: string
  name?: string
  currency?: string
  timezone?: string
  login_customer_id?: string
  access_token?: string
  refresh_token?: string
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = (await request.json()) as ConnectBody

    if (body.platform !== 'meta' && body.platform !== 'google') {
      return NextResponse.json(
        { error: 'Plataforma inválida (use "meta" ou "google")' },
        { status: 400 },
      )
    }
    if (!body.external_id?.trim() || !body.name?.trim()) {
      return NextResponse.json(
        { error: 'Informe o id e o nome da conta de anúncio' },
        { status: 400 },
      )
    }
    if (body.platform === 'meta' && !body.access_token?.trim()) {
      return NextResponse.json(
        { error: 'A Meta exige um token de acesso' },
        { status: 400 },
      )
    }
    if (body.platform === 'google' && !body.refresh_token?.trim()) {
      return NextResponse.json(
        { error: 'O Google Ads exige um refresh token' },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('ad_accounts')
      .upsert(
        {
          account_id: accountId,
          user_id: userId,
          platform: body.platform,
          external_id: body.external_id.trim(),
          name: body.name.trim(),
          currency: body.currency?.trim() || 'BRL',
          timezone: body.timezone?.trim() || null,
          login_customer_id: body.login_customer_id?.trim() || null,
          access_token: body.access_token ? encrypt(body.access_token.trim()) : null,
          refresh_token: body.refresh_token ? encrypt(body.refresh_token.trim()) : null,
          status: 'connected',
          // Reconectar uma conta que estava em erro precisa limpar a
          // mensagem antiga, senão a UI segue mostrando a falha de ontem
          // como se fosse de agora.
          sync_error: null,
        },
        { onConflict: 'account_id,platform,external_id' },
      )
      .select(SAFE_COLUMNS)
      .single()

    if (error) {
      console.error('[ads accounts] falha ao conectar:', error)
      return NextResponse.json({ error: 'Falha ao conectar a conta' }, { status: 500 })
    }

    return NextResponse.json({ account: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PUT — descobre quais contas de anúncio um token enxerga.
 *
 * Passo intermediário do fluxo de conexão: o usuário cola o token (ou
 * volta do OAuth), a UI pergunta aqui quais contas existem, e ele
 * escolhe. Sem isso ele teria de saber de cor o `act_...` da Meta ou o
 * customer id do Google — que é onde a maioria erra e desiste.
 *
 * Não grava nada. É PUT (e não GET) só porque carrega um token no corpo,
 * e token não deve viajar em query string: ele aparece em log de acesso,
 * em histórico do navegador e no `Referer`.
 */
export async function PUT(request: Request) {
  try {
    await requireRole('admin')
    const body = (await request.json()) as {
      platform?: 'meta' | 'google'
      access_token?: string
    }

    if (!body.access_token?.trim()) {
      return NextResponse.json({ error: 'Informe o token' }, { status: 400 })
    }

    if (body.platform === 'meta') {
      const accounts = await listMetaAdAccounts(body.access_token.trim())
      return NextResponse.json({
        accounts: accounts.map((a) => ({
          external_id: a.id,
          name: a.name,
          currency: a.currency,
          timezone: a.timezone_name ?? null,
        })),
      })
    }

    if (body.platform === 'google') {
      const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      if (!developerToken) {
        return NextResponse.json(
          { error: 'GOOGLE_ADS_DEVELOPER_TOKEN não configurado no servidor' },
          { status: 503 },
        )
      }
      const accounts = await listGoogleAdsAccounts(
        body.access_token.trim(),
        developerToken,
      )
      return NextResponse.json({
        accounts: accounts
          // Conta gestora (MCC) não veicula anúncio nem tem gasto
          // próprio; oferecê-la geraria uma conexão que sincroniza zero.
          .filter((a) => !a.manager)
          .map((a) => ({
            external_id: a.id,
            name: a.descriptiveName,
            currency: a.currencyCode,
            timezone: a.timeZone,
          })),
      })
    }

    return NextResponse.json({ error: 'Plataforma inválida' }, { status: 400 })
  } catch (err) {
    if (err instanceof MetaAdsError || err instanceof GoogleAdsError) {
      // Erro da plataforma é do usuário resolver (token vencido, escopo
      // faltando) — a mensagem original é o que orienta, então ela passa.
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}
