/**
 * O código curto que atravessa o pulo landing page -> WhatsApp.
 *
 * O problema que ele resolve: quando alguém clica no botão de WhatsApp de
 * uma LP, o navegador entrega a pessoa ao app do WhatsApp e descarta
 * TUDO — querystring, cookie, `Referer`, localStorage. Do outro lado
 * chega só um telefone e um texto. Não existe pixel, cookie de terceiro
 * ou fingerprint que sobreviva a isso: o único canal entre a página e a
 * conversa é o corpo da mensagem.
 *
 * Então gravamos o clique do lado do servidor (com gclid/utm/gbraid) e
 * embutimos no texto pré-preenchido um token curto que aponta para
 * aquela linha. Quando a mensagem chega no webhook, lemos o token de
 * volta e a conversa fica ligada ao clique — e por tabela ao anúncio.
 *
 * Escolhas do alfabeto:
 *   - base32 de Crockford (sem I, L, O, U): a pessoa às vezes digita o
 *     código à mão ou lê em voz alta; `0/O` e `1/I/L` são o erro clássico.
 *     `U` sai fora porque forma palavrão em combinações comuns em PT-BR.
 *   - maiúsculas: destaca o token no meio da frase e evita ambiguidade
 *     de case na comparação (normalizamos tudo para maiúscula).
 */

/** Crockford base32 sem I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TOKEN_LENGTH = 6

/**
 * Como o token aparece no texto: `[#K7QM2X]`.
 *
 * Os colchetes fazem duas coisas. Visualmente separam o código da frase,
 * então a pessoa entende que é um carimbo e não apaga por engano. E na
 * leitura eles dão uma âncora forte pro regex, o que evita casar com um
 * `#` qualquer que o usuário tenha digitado.
 */
export function formatClickToken(token: string): string {
  return `[#${token}]`
}

/**
 * Aceita o token com ou sem colchetes, em qualquer caixa, em qualquer
 * posição do texto.
 *
 * Tolerante de propósito: o WhatsApp deixa a pessoa editar a mensagem
 * pré-preenchida antes de enviar, e uma parte delas apaga os colchetes,
 * quebra a linha no meio ou manda o código sozinho depois. Exigir o
 * formato exato jogaria fora atribuição real.
 */
const TOKEN_PATTERN = new RegExp(
  `[[(]?#\\s*([${ALPHABET}]{${TOKEN_LENGTH}})\\s*[\\])]?`,
  'i',
)

/**
 * Gera um token novo. Usa `crypto.getRandomValues` (disponível no
 * runtime do Node 18+ e no Edge) e não `Math.random`: o token é um
 * identificador público que aparece na URL de redirect, e um gerador
 * previsível deixaria alguém enumerar cliques de outra conta.
 */
export function generateClickToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) {
    // Módulo 32 sobre 256 é uniforme (256 = 8 * 32), então não há viés
    // para o começo do alfabeto.
    out += ALPHABET[b % ALPHABET.length]
  }
  return out
}

/**
 * Extrai o token do texto de uma mensagem recebida.
 * Devolve `null` quando não há nada parecido — o caso comum, já que a
 * maioria das mensagens é orgânica.
 */
export function extractClickToken(text: string | null | undefined): string | null {
  if (!text) return null
  const match = TOKEN_PATTERN.exec(text)
  if (!match) return null
  return match[1].toUpperCase()
}

/**
 * Monta o texto que o WhatsApp vai abrir já digitado.
 *
 * O token vai no FIM e depois de uma linha em branco. A frase que a
 * pessoa lê primeiro continua sendo a dela; o carimbo fica visualmente
 * separado, parecendo um protocolo de atendimento — que é como as
 * pessoas o interpretam, e por isso não apagam.
 */
export function buildPrefillText(
  humanText: string | null | undefined,
  token: string,
): string {
  const base = (humanText ?? '').trim() || 'Olá! Vim pelo anúncio.'
  return `${base}\n\n${formatClickToken(token)}`
}

/**
 * URL do `wa.me` com o texto já preenchido.
 *
 * `phone` em E.164 SEM o `+` — é o formato que o wa.me exige; com `+` a
 * página abre em branco.
 */
export function buildWaMeUrl(phone: string, prefillText: string): string {
  const digits = phone.replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefillText)}`
}

/** Só para a UI de criação de link: valida o slug que o usuário escolhe. */
export function isValidLinkCode(code: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,30}$/.test(code)
}
