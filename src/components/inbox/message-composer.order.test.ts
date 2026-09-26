import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'message-composer.tsx'), 'utf8')

describe('botão de agendar no compositor', () => {
  it('fica entre o botão de modelo e o de rascunho com IA', () => {
    const template = src.indexOf('t("sendTemplate")')
    const schedule = src.indexOf('t("scheduleMessage")')
    const draft = src.indexOf('t("draftWithAI")')
    expect(template).toBeGreaterThan(-1)
    expect(schedule).toBeGreaterThan(template)
    expect(draft).toBeGreaterThan(schedule)
  })

  it('não é desabilitado por sessionExpired', () => {
    const start = src.indexOf('t("scheduleMessage")')
    const end = src.indexOf('</GatedButton>', start)
    expect(start).toBeGreaterThan(-1)
    expect(src.slice(start, end)).not.toContain('sessionExpired')
  })
})
