import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

/** Mesmo padrão de /api/flows/cron. Devolve a resposta de erro, ou null se autorizado. */
export function verifyCronSecret(request: Request): Response | null {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
