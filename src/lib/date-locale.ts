import { setDefaultOptions } from 'date-fns'
import { ptBR } from 'date-fns/locale/pt-BR'
import { ko } from 'date-fns/locale/ko'
import { enUS } from 'date-fns/locale/en-US'
import type { Locale } from 'date-fns'

/**
 * Faz o date-fns falar o mesmo idioma do resto do app.
 *
 * O problema: o app tem ~8 pontos que chamam `format()` e
 * `formatDistanceToNow()` do date-fns direto — nomes de mês na linha do
 * tempo, "about 2 hours ago" nas notificações, cabeçalhos de dia na
 * conversa. Nenhum deles passa locale, então o date-fns usa o padrão
 * dele, que é inglês — e continuaria em inglês mesmo com todo o catálogo
 * traduzido. Ficaria "há 3 mensagens" ao lado de "about 2 hours ago".
 *
 * A correção poderia ser passar `{ locale }` em cada chamada, mas seriam
 * oito arquivos e a próxima chamada nova nasceria em inglês de novo.
 * `setDefaultOptions` resolve de uma vez: é estado global do módulo, e
 * toda chamada sem locale explícito passa a usar este.
 *
 * Importado por efeito colateral no layout raiz — precisa rodar ANTES da
 * primeira formatação, e a importação do layout garante isso tanto no
 * servidor quanto no cliente.
 */

const LOCALES: Record<string, Locale> = {
  'pt-BR': ptBR,
  pt: ptBR,
  ko,
  en: enUS,
  'en-US': enUS,
}

/**
 * Lido de `NEXT_PUBLIC_APP_LOCALE` e não do `getLocale()` do next-intl
 * porque este módulo roda nos dois lados. A variável é inlinada no build
 * pelo Next, então o valor está disponível no navegador sem nenhuma
 * ponte de servidor para cliente.
 */
const configured = process.env.NEXT_PUBLIC_APP_LOCALE ?? 'en'

setDefaultOptions({ locale: LOCALES[configured] ?? enUS })

/** Exportado para quem precisar do objeto (ex.: sobrepor num teste). */
export const dateFnsLocale = LOCALES[configured] ?? enUS
