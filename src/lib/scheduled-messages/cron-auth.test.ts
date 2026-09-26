import { afterEach, describe, expect, it } from 'vitest'
import { verifyCronSecret } from './cron-auth'

const req = (secret?: string) =>
  new Request('http://x/api', { headers: secret ? { 'x-cron-secret': secret } : {} })

afterEach(() => { delete process.env.AUTOMATION_CRON_SECRET })

describe('verifyCronSecret', () => {
  it('503 quando o segredo não está configurado', () => {
    expect(verifyCronSecret(req('x'))!.status).toBe(503)
  })
  it('401 sem header, com header errado e com tamanho diferente', () => {
    process.env.AUTOMATION_CRON_SECRET = 'segredo-certo'
    expect(verifyCronSecret(req())!.status).toBe(401)
    expect(verifyCronSecret(req('segredo-errad0'))!.status).toBe(401)
    expect(verifyCronSecret(req('curto'))!.status).toBe(401)
  })
  it('null quando o segredo confere', () => {
    process.env.AUTOMATION_CRON_SECRET = 'segredo-certo'
    expect(verifyCronSecret(req('segredo-certo'))).toBeNull()
  })
})
