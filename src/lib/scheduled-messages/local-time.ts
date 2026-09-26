const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-10-01" + "09:30" digitados no navegador → instante ISO (UTC). */
export function localToIso(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) return null
  const [y, mo, day, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number)
  const local = new Date(y, mo - 1, day, h, mi, 0, 0)
  // new Date(2026, 12, 45) "rola" para o mês seguinte; recusa isso.
  if (
    local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== day ||
    local.getHours() !== h || local.getMinutes() !== mi
  ) {
    return null
  }
  return local.toISOString()
}

/** Sugestão inicial: agora + 1 h, arredondado para cima em 5 min, no fuso local. */
export function defaultLocalSlot(now: Date): { date: string; time: string } {
  const d = new Date(now.getTime() + 60 * 60 * 1000)
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0)
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}
