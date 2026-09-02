'use client'

// Importado só pelo efeito colateral: `@/lib/date-locale` chama
// `setDefaultOptions` do date-fns no momento da importação.
//
// Por que um componente só para isso: `setDefaultOptions` é estado global
// do MÓDULO, e servidor e cliente são realidades JavaScript separadas —
// importar o módulo no layout raiz (que é server component) configura o
// date-fns só do lado do servidor. As páginas que formatam data são
// client components e vivem em outro bundle; sem esta ponte, a data
// renderizada no servidor sairia em português e a mesma data,
// reformatada depois da hidratação, voltaria para o inglês.
//
// Não renderiza nada. Fica montado no layout raiz, ao lado do toaster.
import '@/lib/date-locale'

export function DateLocaleBoot() {
  return null
}
