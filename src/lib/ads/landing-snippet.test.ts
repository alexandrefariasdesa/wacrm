import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * O snippet da landing page e a rota `/api/track/[code]` são as duas
 * pontas de um mesmo contrato: a página repassa parâmetros da URL, o
 * servidor os lê e grava.
 *
 * Eles vivem em arquivos diferentes, em linguagens diferentes, e um
 * deles roda em servidores que não são nossos — quem hospeda a LP colou
 * o snippet uma vez e não vai colar de novo. Quando alguém acrescenta um
 * parâmetro na rota e esquece do snippet, nada quebra: o build passa, a
 * rota funciona, o clique é gravado — só que aquele campo chega sempre
 * nulo, e a atribuição degrada em silêncio.
 *
 * Este teste é o cabo entre as duas pontas. Ele lê os dois arquivos e
 * exige que a lista de parâmetros do snippet cubra tudo que a rota lê.
 */

const ROOT = process.cwd()
const SNIPPET = join(ROOT, 'docs', 'snippet-landing-page.html')
const ROUTE = join(ROOT, 'src', 'app', 'api', 'track', '[code]', 'route.ts')

/**
 * Os nomes dentro do array `KEEP = [...]` do snippet.
 *
 * Os comentários `//` são removidos ANTES de procurar as aspas. Cada
 * linha do array tem um comentário ao lado explicando de onde vem o
 * parâmetro, e sem essa limpeza um item comentado — que o navegador
 * ignora — continuaria contando como presente. Foi assim que a primeira
 * versão deste teste passou com `ad_id` desativado.
 */
function snippetParams(): string[] {
  const html = readFileSync(SNIPPET, 'utf8')
  const match = /var KEEP = \[([\s\S]*?)\]/.exec(html)
  if (!match) throw new Error('array KEEP não encontrado no snippet')
  const withoutComments = match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * Os nomes que a rota lê da querystring, via o helper `q('...')`.
 *
 * `lp` é lido pela rota mas escrito pelo snippet fora do KEEP (ele o
 * calcula, não o copia), então sai da comparação.
 */
function routeParams(): string[] {
  const source = readFileSync(ROUTE, 'utf8')
  const found = [...source.matchAll(/\bq\('([^']+)'\)/g)].map((m) => m[1])
  return [...new Set(found)].filter((name) => name !== 'lp')
}

describe('snippet da landing page x rota de rastreio', () => {
  it('o snippet repassa todo parâmetro que a rota lê', () => {
    const fromSnippet = new Set(snippetParams())
    const missing = routeParams().filter((name) => !fromSnippet.has(name))

    expect(
      missing,
      `A rota lê estes parâmetros e o snippet não os repassa: ${missing.join(', ')}. ` +
        'Acrescente-os ao array KEEP em docs/snippet-landing-page.html — sem isso ' +
        'o campo chega sempre nulo e a atribuição degrada sem erro nenhum.',
    ).toEqual([])
  })

  it('a rota lê algum parâmetro (protege o próprio teste)', () => {
    // Se o regex de extração quebrar, `routeParams()` volta vazio e o
    // teste acima passa sem verificar nada.
    expect(routeParams().length).toBeGreaterThan(5)
  })

  it('o snippet declara algum parâmetro (protege o próprio teste)', () => {
    expect(snippetParams().length).toBeGreaterThan(5)
  })

  it('carrega o id do criativo, que é o que separa um anúncio do outro', () => {
    // Sem `ad_id` o painel só consegue agrupar por campanha, e a
    // pergunta "qual criativo eu corto?" fica sem resposta. É o
    // parâmetro mais fácil de esquecer, porque tudo continua
    // funcionando sem ele.
    expect(snippetParams()).toContain('ad_id')
    expect(routeParams()).toContain('ad_id')
  })

  it('carrega os substitutos do gclid', () => {
    // `gbraid` / `wbraid` chegam no lugar do `gclid` quando o
    // consentimento é negado — justamente a fatia de tráfego que some
    // dos relatórios de quem não os trata.
    const params = snippetParams()
    expect(params).toContain('gbraid')
    expect(params).toContain('wbraid')
  })
})
