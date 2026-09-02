import { describe, expect, it } from 'vitest'
import {
  buildPrefillText,
  buildWaMeUrl,
  extractClickToken,
  formatClickToken,
  generateClickToken,
  isValidLinkCode,
} from './click-token'

/**
 * O token é o ÚNICO fio que sobrevive ao pulo da landing page para o
 * WhatsApp — não há cookie, querystring nem Referer do outro lado. Se a
 * leitura falhar, o lead chega sem origem e o CPL daquele anúncio some.
 * Por isso o foco destes testes é a tolerância da extração.
 */

describe('generateClickToken', () => {
  it('produz 6 caracteres do alfabeto sem I, L, O e U', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateClickToken()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
    }
  })

  it('não repete em 1000 sorteios', () => {
    // Não é prova de unicidade (o índice único do banco é quem garante),
    // mas pega um gerador travado num valor só.
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateClickToken())
    expect(seen.size).toBe(1000)
  })
})

describe('extractClickToken', () => {
  const token = 'K7QM2X'

  it('lê o formato que a gente mesmo gera', () => {
    expect(extractClickToken(buildPrefillText('Olá!', token))).toBe(token)
  })

  it('lê mesmo quando a pessoa apaga os colchetes antes de enviar', () => {
    // O WhatsApp deixa editar o texto pré-preenchido, e uma parte das
    // pessoas apaga o que parece "sujeira". Exigir o formato exato
    // jogaria fora atribuição real.
    expect(extractClickToken(`Oi, quero saber mais #${token}`)).toBe(token)
  })

  it('aceita o token sozinho, numa mensagem posterior', () => {
    expect(extractClickToken(`#${token}`)).toBe(token)
  })

  it('normaliza para maiúsculas', () => {
    expect(extractClickToken('oi [#k7qm2x]')).toBe(token)
  })

  it('acha o token no meio de um texto longo com quebras de linha', () => {
    const text = `Boa tarde!\n\nVi o anúncio de vocês.\n\n[#${token}]\n\nObrigado`
    expect(extractClickToken(text)).toBe(token)
  })

  it('devolve null em mensagem orgânica — o caso mais comum', () => {
    expect(extractClickToken('Oi, vocês entregam em Manaus?')).toBeNull()
    expect(extractClickToken('')).toBeNull()
    expect(extractClickToken(null)).toBeNull()
    expect(extractClickToken(undefined)).toBeNull()
  })

  it('não casa com uma hashtag comum', () => {
    // "#promo" tem 5 letras; "#sextou" tem letras fora do alfabeto.
    // Um falso positivo aqui atribuiria um lead orgânico a um anúncio.
    expect(extractClickToken('adorei #promo')).toBeNull()
    expect(extractClickToken('bom dia #sextou')).toBeNull()
  })

  it('não casa com uma sequência de 6 sem o marcador #', () => {
    expect(extractClickToken('meu pedido K7QM2X chegou')).toBeNull()
  })
})

describe('buildPrefillText', () => {
  it('mantém a frase da pessoa e separa o carimbo', () => {
    const out = buildPrefillText('Quero um orçamento', 'ABC123')
    expect(out).toBe('Quero um orçamento\n\n[#ABC123]')
  })

  it('usa um texto padrão quando o link não define nenhum', () => {
    expect(buildPrefillText(null, 'ABC123')).toContain('[#ABC123]')
    expect(buildPrefillText('   ', 'ABC123')).toContain('anúncio')
  })

  it('o resultado sempre volta a ser lido pelo extrator', () => {
    // Invariante do par gerar/ler: se um dia divergirem, toda atribuição
    // por link para de funcionar em silêncio.
    for (let i = 0; i < 50; i++) {
      const token = generateClickToken()
      expect(extractClickToken(buildPrefillText('oi', token))).toBe(token)
    }
  })
})

describe('buildWaMeUrl', () => {
  it('remove o + do telefone — com ele o wa.me abre em branco', () => {
    const url = buildWaMeUrl('+55 11 99999-9999', 'oi')
    expect(url).toBe('https://wa.me/5511999999999?text=oi')
  })

  it('escapa o texto para a querystring', () => {
    const url = buildWaMeUrl('5511999999999', 'Olá! Vim pelo anúncio\n\n[#ABC123]')
    expect(url).toContain('%23ABC123')
    expect(url).not.toContain(' ')
  })
})

describe('formatClickToken', () => {
  it('envolve em colchetes', () => {
    expect(formatClickToken('ABC123')).toBe('[#ABC123]')
  })
})

describe('isValidLinkCode', () => {
  it('aceita o que cabe numa URL pública', () => {
    expect(isValidLinkCode('busca-marca')).toBe(true)
    expect(isValidLinkCode('lp_verao_2026')).toBe(true)
    expect(isValidLinkCode('a1')).toBe(true)
  })

  it('recusa maiúscula, espaço, acento e barra', () => {
    expect(isValidLinkCode('Busca-Marca')).toBe(false)
    expect(isValidLinkCode('busca marca')).toBe(false)
    expect(isValidLinkCode('promoção')).toBe(false)
    expect(isValidLinkCode('a/b')).toBe(false)
  })

  it('recusa muito curto e muito longo', () => {
    expect(isValidLinkCode('a')).toBe(false)
    expect(isValidLinkCode('a'.repeat(32))).toBe(false)
    expect(isValidLinkCode('a'.repeat(31))).toBe(true)
  })

  it('recusa código começando por hífen — vira flag na linha de comando', () => {
    expect(isValidLinkCode('-promo')).toBe(false)
  })
})
