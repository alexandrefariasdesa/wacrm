import { randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

/**
 * Proteção CSRF do fluxo OAuth das plataformas de anúncio.
 *
 * O ataque concreto sem isto: alguém induz o admin a abrir uma URL de
 * callback forjada, com um `code` da conta de anúncio DO ATACANTE. O
 * callback troca o code por token e conecta a conta do atacante no
 * tenant da vítima — que passa a ver gasto de outra pessoa no painel, e
 * cujo cron passa a bater na API com credencial de terceiro.
 *
 * O `state` fecha isso: a plataforma devolve exatamente o valor que
 * mandamos, e ele só existe num cookie httpOnly do próprio navegador que
 * iniciou o fluxo.
 */

const COOKIE_NAME = 'ads_oauth_state'
/** 10 minutos: tempo de sobra para autorizar, curto o bastante para um
 *  state vazado não ficar útil. */
const MAX_AGE_SECONDS = 600

/** Gera o state, guarda no cookie e devolve para ir na URL. */
export async function issueOAuthState(platform: 'meta' | 'google'): Promise<string> {
  const state = `${platform}.${randomBytes(24).toString('base64url')}`
  const jar = await cookies()
  jar.set(COOKIE_NAME, state, {
    httpOnly: true,
    // A plataforma redireciona de volta por navegação de topo vinda de
    // outro site, e um cookie `strict` não seria enviado nesse retorno —
    // o fluxo falharia sempre. `lax` cobre GET de navegação, que é
    // exatamente a forma do callback.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
  return state
}

/**
 * Confere o state devolvido pela plataforma e consome o cookie.
 * Devolve `false` para qualquer divergência — inclusive cookie ausente,
 * que é o caso do link forjado aberto numa sessão nova.
 */
export async function consumeOAuthState(
  returned: string | null,
  platform: 'meta' | 'google',
): Promise<boolean> {
  const jar = await cookies()
  const stored = jar.get(COOKIE_NAME)?.value ?? null
  // Consome sempre, dando certo ou errado: um state reutilizável seria
  // uma janela de replay de 10 minutos.
  jar.delete(COOKIE_NAME)

  if (!stored || !returned) return false
  if (!stored.startsWith(`${platform}.`)) return false

  const a = Buffer.from(stored)
  const b = Buffer.from(returned)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Base pública da aplicação, para montar o `redirect_uri`.
 *
 * `NEXT_PUBLIC_SITE_URL` é a variável que o resto do projeto já usa (ver
 * a cadeia de resolução em `api/account/invitations`); `NEXT_PUBLIC_APP_URL`
 * fica como sinônimo aceito, porque é o nome que aparece na documentação
 * de várias hospedagens e é fácil de setar por engano.
 *
 * Diferente das URLs de convite, esta NÃO é derivada do cabeçalho `Host`
 * da requisição. O `redirect_uri` precisa bater caractere por caractere
 * com o que está cadastrado no app da Meta / do Google: derivar do
 * cabeçalho o faria variar por proxy e por domínio de preview, e cada
 * variação viraria um `redirect_uri mismatch`. Configuração explícita é
 * a única forma estável.
 */
export function appBaseUrl(): string {
  const explicit =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim()
  return explicit ? explicit.replace(/\/+$/, '') : 'http://localhost:3000'
}
