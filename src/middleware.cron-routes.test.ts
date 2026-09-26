import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// O middleware devolve 401 para qualquer /api/whatsapp/* sem sessão. Uma rota de cron
// (autenticada por x-cron-secret, chamada pelo pg_cron sem cookie) que caia nesse prefixo
// nunca chega ao handler. Este teste acha toda rota que usa verifyCronSecret e garante que
// o middleware a deixa passar.
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

import { middleware } from './middleware'

const API = join(process.cwd(), 'src', 'app', 'api')

function cronRoutePaths(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return cronRoutePaths(full)
    if (entry !== 'route.ts' || !readFileSync(full, 'utf8').includes('verifyCronSecret(')) return []
    return ['/api/' + relative(API, join(full, '..')).split(sep).join('/')]
  })
}

describe('rotas de cron e o middleware', () => {
  const paths = cronRoutePaths(API)

  it('encontra ao menos uma rota que usa verifyCronSecret', () => {
    expect(paths.length).toBeGreaterThan(0)
  })

  it.each(paths)('%s passa pelo middleware sem sessão', async (path) => {
    const res = await middleware(new NextRequest('http://localhost' + path))
    expect(res.status).not.toBe(401)
  })

  it('controle: uma rota de /api/whatsapp/ sem sessão continua bloqueada', async () => {
    const res = await middleware(new NextRequest('http://localhost/api/whatsapp/scheduled'))
    expect(res.status).toBe(401)
  })
})
