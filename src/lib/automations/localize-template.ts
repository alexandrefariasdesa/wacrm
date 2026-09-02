import type { AutomationTemplateDefinition, TemplateSlug } from './templates'

/**
 * Traduz um template de automação.
 *
 * `templates.ts` guarda a ESTRUTURA (gatilho, passos, ordem) e um texto
 * em inglês que serve de referência. O que o usuário lê e o que a
 * automação vai enviar saem daqui, do catálogo — em `Automations.templates.<slug>`.
 *
 * Por que não traduzir dentro do próprio `templates.ts`: aquele módulo é
 * importado por código de servidor (o motor de automações) que não tem
 * um `t()` de React à mão, e transformar a estrutura em chaves de
 * tradução quebraria os tipos que o construtor consome. Esta função é a
 * fronteira: entra a definição crua, sai a definição traduzida, e só as
 * duas telas que MOSTRAM template a chamam.
 *
 * Importante: o texto traduzido não é só rótulo — vira o conteúdo que a
 * automação envia ao cliente. Um template criado com o app em português
 * precisa nascer com a mensagem em português, não com um texto em inglês
 * que alguém teria de reescrever antes de ativar.
 */

/** Assinatura mínima do `t` do next-intl, para não acoplar ao tipo dele. */
type Translate = (key: string) => string

export function localizeTemplate(
  def: AutomationTemplateDefinition,
  t: Translate,
): AutomationTemplateDefinition {
  const slug = def.slug as TemplateSlug

  // Uma chave que não existe faz o next-intl devolver o próprio caminho
  // ("Automations.templates.x.step0") em vez de lançar. Detectamos isso e
  // caímos no texto original — um template com a estrutura certa e o
  // texto em inglês é bem melhor que um com a keypath no corpo da
  // mensagem, que seria enviada ao cliente assim mesmo.
  const tr = (key: string, fallback: string): string => {
    const value = t(`${slug}.${key}`)
    return value.includes(`${slug}.${key}`) ? fallback : value
  }

  const steps = def.steps.map((seed, index) => {
    // Só passos com texto são traduzidos; espera, atribuição e etiqueta
    // não têm copy.
    const config = seed.step_config as Record<string, unknown>
    if (typeof config.text !== 'string') return seed
    return {
      ...seed,
      step_config: {
        ...config,
        text: tr(`step${index}`, config.text),
      },
    } as typeof seed
  })

  // Palavras-chave de gatilho também são conteúdo: "pricing, quote, buy"
  // não dispara em nada num atendimento em português.
  let trigger_config = def.trigger_config
  const triggerKeywords = (def.trigger_config as { keywords?: string[] }).keywords
  if (triggerKeywords?.length) {
    const translated = tr('keywords', triggerKeywords.join(', '))
    trigger_config = {
      ...def.trigger_config,
      keywords: translated
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    }
  }

  return {
    ...def,
    name: tr('name', def.name),
    description: tr('description', def.description),
    trigger_config,
    steps,
  }
}
