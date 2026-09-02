/**
 * Funde um fragmento de catálogo num arquivo de idioma.
 *
 *   node scripts/merge-locale.mjs messages/pt-BR.json fragmento.json
 *
 * Existe porque um catálogo de 1 500 strings não cabe numa escrita só, e
 * reescrever o arquivo inteiro a cada namespace perderia o que já estava
 * traduzido. A fusão é profunda e o fragmento vence — reexecutar com uma
 * correção sobrescreve só o que mudou.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const [target, fragmentPath] = process.argv.slice(2)
if (!target || !fragmentPath) {
  console.error('uso: merge-locale.mjs <destino.json> <fragmento.json>')
  process.exit(1)
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v)
        ? deepMerge(base?.[k] ?? {}, v)
        : v
  }
  return out
}

const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {}
const fragment = JSON.parse(readFileSync(fragmentPath, 'utf8'))

writeFileSync(
  target,
  `${JSON.stringify(deepMerge(current, fragment), null, 2)}\n`,
  'utf8',
)

// Relatório de cobertura contra o catálogo de origem, para não descobrir
// só no teste que faltou um namespace.
const source = JSON.parse(readFileSync('messages/en.json', 'utf8'))
const leaves = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? leaves(v, p ? `${p}.${k}` : k) : [p ? `${p}.${k}` : k],
  )
const done = new Set(leaves(JSON.parse(readFileSync(target, 'utf8'))))
const all = leaves(source)
const missing = all.filter((k) => !done.has(k))
console.log(
  `${target}: ${all.length - missing.length}/${all.length} chaves — faltam ${missing.length}`,
)
if (missing.length && missing.length <= 40) console.log(missing.join('\n'))
else if (missing.length) {
  const namespaces = [...new Set(missing.map((k) => k.split('.')[0]))]
  console.log('namespaces incompletos:', namespaces.join(', '))
}
