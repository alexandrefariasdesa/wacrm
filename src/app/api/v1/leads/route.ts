// ============================================================
// POST /api/v1/leads — lead de formulário externo (scope: contacts:write)
//
// Numa chamada só: acha-ou-cria o contato pelo telefone, soma as
// etiquetas, grava o clique com toda a atribuição (UTMs, ids de clique,
// id do anúncio, página e referrer), liga esse toque ao contato e
// devolve o token que vai carimbado na mensagem do WhatsApp.
//
// Corpo:
//   { phone, name?, email?, tags?: string[], attribution?: {...},
//     click_token?: "ABC123",    // token proposto (Crockford base32, 6)
//     create_deal?: boolean,     // padrão true
//     pipeline_id?: uuid,        // padrão: o funil que "recebe leads"
//     deal_title?: string }
// Resposta 201/200:
//   { data: { contact: ApiContact, created, click_token, whatsapp_tag,
//             deal: { id, created } | null } }
//
// Falha de atribuição ou de negócio NÃO derruba o lead: o contato é o que
// importa; o resto é gravado em melhor esforço.
//
// O NEGÓCIO: o lead nasce na primeira etapa do funil comercial para que o
// vendedor o veja e, ao arrastá-lo para "Qualificado", o custo por lead
// qualificado do criativo passe a existir (migration 044). Se o contato
// já tem um negócio ABERTO nesse funil, reusa — a mesma pessoa preenchendo
// o formulário duas vezes não pode virar dois cards.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  setContactTags,
  getContactById,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';
import {
  parseAttribution,
  hasAttribution,
  mergeTagNames,
  buildClickRow,
  proposedToken,
  parseDealRequest,
  type DealRequest,
} from '@/lib/api/v1/leads';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatClickToken } from '@/lib/ads/click-token';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) return fail('bad_request', "'phone' is required", 400);

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id: contactId, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: typeof body.name === 'string' ? body.name.slice(0, 120) : undefined,
        email: typeof body.email === 'string' ? body.email.slice(0, 254) : undefined,
      }
    );

    // Contato que já existia: completa o que estiver vazio, sem
    // sobrescrever o que o atendimento já corrigiu à mão.
    if (!created) {
      const { data: row } = await ctx.supabase
        .from('contacts')
        .select('name, phone, email')
        .eq('id', contactId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      const patch: Record<string, string> = {};
      if (row && !row.email && typeof body.email === 'string' && body.email) {
        patch.email = body.email.slice(0, 254);
      }
      if (
        row &&
        (!row.name || row.name === row.phone) &&
        typeof body.name === 'string' &&
        body.name
      ) {
        patch.name = body.name.slice(0, 120);
      }
      if (Object.keys(patch).length > 0) {
        await ctx.supabase
          .from('contacts')
          .update(patch)
          .eq('id', contactId)
          .eq('account_id', ctx.accountId);
      }
    }

    if (Array.isArray(body.tags)) {
      const incoming = body.tags.filter((t): t is string => typeof t === 'string');
      if (incoming.length > 0) {
        const current = await getContactById(ctx.supabase, ctx.accountId, contactId);
        const currentNames = (current?.tags ?? []).map((t) => t.name);
        await setContactTags(
          ctx.supabase,
          ctx.accountId,
          auditUserId,
          contactId,
          mergeTagNames(currentNames, incoming)
        );
      }
    }

    // Atribuição, em melhor esforço.
    const attribution = parseAttribution(body.attribution);
    // Token proposto pelo chamador (já impresso na mensagem) vale na 1ª
    // tentativa; se colidir, gera outro — a mensagem já saiu, mas o clique
    // e o toque ficam gravados de qualquer forma.
    const proposed = proposedToken(body.click_token);
    let clickToken: string | null = null;
    try {
      for (let attempt = 0; attempt < 3 && !clickToken; attempt++) {
        const row =
          attempt === 0 && proposed
            ? buildClickRow(ctx.accountId, attribution, proposed)
            : buildClickRow(ctx.accountId, attribution);
        const { data: click, error } = await ctx.supabase
          .from('ad_clicks')
          .insert(row)
          .select('id')
          .single();
        if (error) {
          if (error.code === '23505') continue; // colisão de token
          console.error('[api/v1/leads] click insert error:', error);
          break;
        }
        clickToken = row.click_token;

        if (hasAttribution(attribution)) {
          // Liga o toque ao anúncio JÁ espelhado, quando existir. Esperar o
          // backfill do próximo sync deixava o lead numa linha separada do
          // gasto por até uma hora.
          const local = await resolveLocalAd(
            ctx.supabase,
            ctx.accountId,
            row.ad_external_id,
            row.adset_external_id
          );
          const { error: touchError } = await ctx.supabase
            .from('attribution_touches')
            .insert({
              account_id: ctx.accountId,
              contact_id: contactId,
              platform: row.platform,
              source: 'link_code',
              ad_click_id: click.id,
              ad_id: local.adId,
              ad_group_id: local.adGroupId,
              campaign_id: local.campaignId,
              ad_external_id: row.ad_external_id,
              adset_external_id: row.adset_external_id,
              campaign_external_id: row.campaign_external_id,
              gclid: row.gclid,
              utm_source: row.utm_source,
              utm_medium: row.utm_medium,
              utm_campaign: row.utm_campaign,
              utm_content: row.utm_content,
              utm_term: row.utm_term,
            });
          if (touchError) {
            console.error('[api/v1/leads] touch insert error:', touchError);
          }
        }
      }
    } catch (err) {
      console.error('[api/v1/leads] attribution failed:', err);
    }

    let deal: { id: string; created: boolean } | null = null;
    try {
      deal = await ensureDeal(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        contactId,
        parseDealRequest(body),
        typeof body.name === 'string' && body.name.trim() ? body.name.trim() : phone
      );
    } catch (err) {
      console.error('[api/v1/leads] deal failed:', err);
    }

    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);
    return ok(
      {
        contact,
        created,
        click_token: clickToken,
        whatsapp_tag: clickToken ? formatClickToken(clickToken) : null,
        deal,
      },
      created ? 201 : 200
    );
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}

/** Anúncio / conjunto / campanha locais a partir dos ids crus da plataforma. */
async function resolveLocalAd(
  db: SupabaseClient,
  accountId: string,
  adExternalId: string | null,
  adsetExternalId: string | null
): Promise<{ adId: string | null; adGroupId: string | null; campaignId: string | null }> {
  if (adExternalId) {
    const { data } = await db
      .from('ads')
      .select('id, ad_group_id, campaign_id')
      .eq('account_id', accountId)
      .eq('external_id', adExternalId)
      .limit(1)
      .maybeSingle();
    if (data) {
      return {
        adId: data.id as string,
        adGroupId: (data.ad_group_id as string | null) ?? null,
        campaignId: (data.campaign_id as string | null) ?? null,
      };
    }
  }
  if (adsetExternalId) {
    const { data } = await db
      .from('ad_groups')
      .select('id, campaign_id')
      .eq('account_id', accountId)
      .eq('external_id', adsetExternalId)
      .limit(1)
      .maybeSingle();
    if (data) {
      return {
        adId: null,
        adGroupId: data.id as string,
        campaignId: (data.campaign_id as string | null) ?? null,
      };
    }
  }
  return { adId: null, adGroupId: null, campaignId: null };
}

/** Acha o negócio aberto do contato no funil de entrada, ou cria na 1ª etapa. */
async function ensureDeal(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  req: DealRequest,
  fallbackTitle: string
): Promise<{ id: string; created: boolean } | null> {
  if (!req.create) return null;

  let pipelineQuery = db.from('pipelines').select('id').eq('account_id', accountId);
  pipelineQuery = req.pipelineId
    ? pipelineQuery.eq('id', req.pipelineId)
    : pipelineQuery.eq('receives_api_leads', true);
  const { data: pipeline } = await pipelineQuery.limit(1).maybeSingle();
  // Nenhum funil marcado: comportamento anterior (só contato). Não é erro —
  // conta que não usa funil continua funcionando.
  if (!pipeline) return null;

  const { data: open } = await db
    .from('deals')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('pipeline_id', pipeline.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) return { id: open.id as string, created: false };

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!stage) return null;

  const { data: acct } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle();

  const { data: inserted, error } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: contactId,
      title: req.title ?? fallbackTitle,
      value: 0,
      currency: acct?.default_currency ?? 'USD',
      status: 'open',
    })
    .select('id')
    .single();
  if (error || !inserted) {
    console.error('[api/v1/leads] deal insert error:', error);
    return null;
  }
  return { id: inserted.id as string, created: true };
}
