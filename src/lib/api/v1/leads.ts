// ============================================================
// Lead vindo de formulário externo (landing page / portal).
//
// O `/api/track/<code>` resolve a atribuição de quem clica num botão
// de WhatsApp sem se identificar. Um formulário é o caso oposto: a
// pessoa já disse nome, e-mail e telefone ANTES de ir para o WhatsApp,
// então dá para ligar a origem ao contato na hora — sem esperar a
// primeira mensagem chegar (e sem perder o lead que desiste no meio).
//
// Esta camada é pura (sem Next, sem rede) para os testes exercitarem.
// ============================================================

import { generateClickToken } from '@/lib/ads/click-token';

export interface LeadAttribution {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  /** Cookie `_fbc` da Meta (fbclid carimbado com a hora do clique). */
  fbc?: string | null;
  /** Cookie `_fbp` da Meta (identifica o navegador). */
  fbp?: string | null;
  ad_id?: string | null;
  adset_id?: string | null;
  campaign_id?: string | null;
  /** `{{placement}}` da Meta: feed, stories, reels... */
  placement?: string | null;
  landing_url?: string | null;
  referrer?: string | null;
}

export type LeadPlatform = 'meta' | 'google' | 'other';

const ATTRIBUTION_KEYS: (keyof LeadAttribution)[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'fbc',
  'fbp',
  'ad_id',
  'adset_id',
  'campaign_id',
  'placement',
  'landing_url',
  'referrer',
];

/** Valores de atribuição são rótulos/ids curtos; URLs ganham mais folga. */
function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > 0 ? clean.slice(0, max) : null;
}

/** Lê o bloco `attribution` do corpo, descartando o que não conhece. */
export function parseAttribution(raw: unknown): LeadAttribution {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: LeadAttribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const max = key === 'landing_url' || key === 'referrer' ? 1024 : 512;
    const value = clip(src[key], max);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * De qual plataforma veio o clique.
 *
 * O id de clique é a prova mais forte (a plataforma o carimba sozinha);
 * a `utm_source` é o que o gestor escreveu à mão, então só decide quando
 * não há id nenhum.
 */
export function inferPlatform(a: LeadAttribution): LeadPlatform {
  if (a.fbclid || a.fbc) return 'meta';
  if (a.gclid || a.gbraid || a.wbraid) return 'google';
  const source = (a.utm_source ?? '').toLowerCase();
  if (/(facebook|instagram|meta|fb|ig)\b/.test(source)) return 'meta';
  if (/(google|youtube|gads|adwords)\b/.test(source)) return 'google';
  return 'other';
}

/**
 * Chaves que NÃO provam anúncio sozinhas: a página e o referrer existem em
 * qualquer visita, e o `_fbp` é gravado pelo pixel em todo navegador —
 * inclusive no de quem chegou pelo Google orgânico.
 */
const NON_CAMPAIGN_KEYS = new Set<keyof LeadAttribution>(['landing_url', 'referrer', 'fbp']);

/** Tem algum sinal de anúncio/campanha? Sem nenhum, não há toque a gravar. */
export function hasAttribution(a: LeadAttribution): boolean {
  return ATTRIBUTION_KEYS.some((k) => !NON_CAMPAIGN_KEYS.has(k) && Boolean(a[k]));
}

/**
 * Etiquetas do contato depois deste lead: as que ele já tinha + as novas.
 *
 * `setContactTags` SUBSTITUI o conjunto. Mandar só as do lead de agora
 * apagaria a etiqueta do curso que a mesma pessoa pediu semana passada.
 */
export function mergeTagNames(current: string[], incoming: string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of [...current, ...incoming]) {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()];
}

const TOKEN_FORMAT = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

/**
 * Token proposto por quem chama, se tiver o formato certo.
 *
 * O portal gera o token ELE MESMO e já o imprime na mensagem do WhatsApp,
 * mandando o lead para cá em segundo plano: esperar esta rota (vários
 * round-trips até o banco) deixava a pessoa 3–5 s parada no pop-up.
 */
export function proposedToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  return TOKEN_FORMAT.test(upper) ? upper : null;
}

/** Linha de `ad_clicks` pronta para inserir (o token é gerado aqui). */
export function buildClickRow(
  accountId: string,
  a: LeadAttribution,
  token: string = generateClickToken()
) {
  return {
    account_id: accountId,
    tracking_link_id: null,
    click_token: token,
    platform: inferPlatform(a),
    gclid: a.gclid ?? null,
    gbraid: a.gbraid ?? null,
    wbraid: a.wbraid ?? null,
    fbclid: a.fbclid ?? null,
    fbc: a.fbc ?? null,
    fbp: a.fbp ?? null,
    utm_source: a.utm_source ?? null,
    utm_medium: a.utm_medium ?? null,
    utm_campaign: a.utm_campaign ?? null,
    utm_content: a.utm_content ?? null,
    utm_term: a.utm_term ?? null,
    ad_external_id: a.ad_id ?? null,
    adset_external_id: a.adset_id ?? null,
    campaign_external_id: a.campaign_id ?? null,
    placement: a.placement ?? null,
    landing_url: a.landing_url ?? null,
    referrer: a.referrer ?? null,
    // O contato já está identificado pelo formulário: o clique nasce
    // casado. Assim, quando a primeira mensagem chegar com o token, o
    // webhook não tenta gravar um segundo toque para o mesmo clique.
    matched_at: new Date().toISOString(),
  };
}

/** O que o chamador pediu sobre o negócio do lead. */
export interface DealRequest {
  /** `false` só grava contato e origem, sem negócio no funil. */
  create: boolean;
  /** Funil explícito. Sem ele, vale o marcado como "recebe leads". */
  pipelineId: string | null;
  title: string | null;
}

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lê `create_deal`, `pipeline_id` e `deal_title` do corpo.
 *
 * O padrão é CRIAR: o lead de formulário existe para cair no funil
 * comercial, e um lead que só vira contato é um lead que nenhum vendedor
 * vê — some do custo por qualificado sem ninguém perceber.
 */
export function parseDealRequest(body: Record<string, unknown>): DealRequest {
  return {
    create: body.create_deal !== false,
    pipelineId:
      typeof body.pipeline_id === 'string' && UUID_FORMAT.test(body.pipeline_id)
        ? body.pipeline_id
        : null,
    title: clip(body.deal_title, 120),
  };
}
