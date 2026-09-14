// ============================================================
// POST /api/v1/leads — lead de formulário externo (scope: contacts:write)
//
// Numa chamada só: acha-ou-cria o contato pelo telefone, soma as
// etiquetas, grava o clique com toda a atribuição (UTMs, ids de clique,
// id do anúncio, página e referrer), liga esse toque ao contato e
// devolve o token que vai carimbado na mensagem do WhatsApp.
//
// Corpo:
//   { phone, name?, email?, tags?: string[], attribution?: {...} }
// Resposta 201/200:
//   { data: { contact: ApiContact, created, click_token, whatsapp_tag } }
//
// Falha de atribuição NÃO derruba o lead: o contato é o que importa; o
// toque é gravado em melhor esforço e `click_token` volta null.
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
} from '@/lib/api/v1/leads';
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
    let clickToken: string | null = null;
    try {
      for (let attempt = 0; attempt < 3 && !clickToken; attempt++) {
        const row = buildClickRow(ctx.accountId, attribution);
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
          const { error: touchError } = await ctx.supabase
            .from('attribution_touches')
            .insert({
              account_id: ctx.accountId,
              contact_id: contactId,
              platform: row.platform,
              source: 'link_code',
              ad_click_id: click.id,
              ad_external_id: row.ad_external_id,
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

    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);
    return ok(
      {
        contact,
        created,
        click_token: clickToken,
        whatsapp_tag: clickToken ? formatClickToken(clickToken) : null,
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
