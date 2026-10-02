// ============================================================
// Receptor do webhook do canal NÃO-OFICIAL (Evolution API).
//
// Irmão de `/api/whatsapp/webhook` (Meta), com três diferenças que
// mandam no desenho:
//
//  1. Autenticação. A Meta assina o corpo (HMAC em `x-hub-signature-256`)
//     e nós conferimos. O Evolution NÃO assina nada. A única prova de
//     origem possível é um segredo que só nós e a instância conhecemos,
//     então ele vai na URL do webhook (`?s=…`) e é comparado em tempo
//     constante contra `whatsapp_config.webhook_secret`. É mais fraco que
//     uma assinatura — um segredo em URL vaza em log de proxy — e por
//     isso ele identifica O CANAL e nada mais: o pior caso de vazamento é
//     alguém conseguir INJETAR mensagem falsa nessa caixa de entrada, não
//     ler nem enviar por ela.
//
//  2. Sem `referral`. Nenhuma atribuição de anúncio entra por aqui — o
//     `ctwa_clid` é coisa da Meta. Lead que chega neste canal fica sem
//     origem, e isso é consequência da escolha do canal, não bug.
//
//  3. Sem mídia baixável (por ora). O Evolution entrega o arquivo em
//     base64 ou por URL própria conforme a configuração; guardamos o
//     tipo e o texto/legenda, e o binário fica fora desta primeira
//     versão. Uma foto aparece na conversa como "[image]" com a legenda.
// ============================================================

import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'crypto';

import { classifyEvolutionEvent } from '@/lib/whatsapp/providers/evolution-inbound';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { reopenClosedConversation } from '@/lib/conversations/reopen';

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/** Comparação em tempo constante que não vaza o tamanho do segredo. */
function secretMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('s') ?? '';

  if (!secret) {
    return NextResponse.json({ error: 'missing secret' }, { status: 401 });
  }

  const db = supabaseAdmin();

  // O segredo identifica o canal. Buscamos os candidatos e comparamos em
  // tempo constante em vez de filtrar por igualdade no banco: um
  // `.eq('webhook_secret', …)` faria o Postgres comparar byte a byte com
  // saída antecipada, que é exatamente o que se quer evitar.
  const { data: channels, error: channelErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('kind', 'unofficial')
    .not('webhook_secret', 'is', null);

  if (channelErr) {
    console.error('[evolution-webhook] channel lookup failed:', channelErr);
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }

  const channel = (channels ?? []).find(
    (c: { webhook_secret: string | null }) =>
      c.webhook_secret && secretMatches(c.webhook_secret, secret)
  );

  if (!channel) {
    console.warn('[evolution-webhook] rejected: no channel for this secret');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const event = classifyEvolutionEvent(payload);

  if (event.kind === 'ignored') {
    return NextResponse.json({ ok: true, ignored: event.reason });
  }

  if (event.kind === 'connection') {
    // A sessão caiu ou voltou. Refletir isso na tela de configuração é o
    // que evita o pior modo de falha deste canal: o QR expira sozinho, e
    // sem este espelho o CRM ficaria "conectado" recebendo silêncio.
    await db
      .from('whatsapp_config')
      .update({
        status: event.state === 'open' ? 'connected' : 'disconnected',
        connected_at:
          event.state === 'open'
            ? new Date().toISOString()
            : channel.connected_at,
        updated_at: new Date().toISOString(),
      })
      .eq('id', channel.id);
    return NextResponse.json({ ok: true, state: event.state });
  }

  const message = event.message;
  const accountId = channel.account_id as string;

  // Contato + conversa, carimbados com ESTE canal — é o que faz a
  // resposta sair pelo mesmo número por onde a mensagem entrou.
  let resolved;
  try {
    resolved = await resolveConversationByPhone(
      db,
      accountId,
      `+${message.phone}`,
      message.pushName,
      channel.id as string
    );
  } catch (err) {
    console.error('[evolution-webhook] could not resolve conversation:', err);
    // 200 de propósito: um erro nosso não pode fazer o Evolution
    // reentregar em laço. O evento fica registrado no log.
    return NextResponse.json({ ok: false, error: 'resolve failed' });
  }

  const outbound = message.direction === 'outbound';

  // Eco do que o próprio CRM enviou: o webhook pode chegar ANTES de o
  // send-message gravar a linha com o id do provedor. Esperar um instante
  // deixa a linha do CRM entrar primeiro, e o upsert abaixo vira no-op em
  // vez de duplicar a bolha.
  if (outbound) await new Promise((r) => setTimeout(r, 2500));

  const contentText =
    message.text ??
    (message.contentType === 'unknown' ? null : `[${message.contentType}]`);

  // Insert idempotente: o Evolution reentrega em caso de ack lento, e o
  // índice único (conversation_id, message_id) da migration 037 faz a
  // repetição virar um no-op. `.select()` vazio = reentrega, e aí todo o
  // fan-out abaixo tem de ser pulado.
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: resolved.conversationId,
        sender_type: outbound ? 'agent' : 'customer',
        content_type:
          message.contentType === 'unknown' ? 'text' : message.contentType,
        content_text: contentText,
        message_id: message.providerMessageId,
        channel_id: channel.id,
        status: outbound ? 'sent' : 'delivered',
        created_at: message.timestamp,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');

  if (msgError) {
    console.error('[evolution-webhook] message insert failed:', msgError);
    return NextResponse.json({ ok: false, error: 'insert failed' });
  }

  const isReplay = !insertedRows || insertedRows.length === 0;
  if (isReplay) {
    return NextResponse.json({ ok: true, replay: true });
  }

  // Mensagem digitada no celular/WhatsApp Web: só espelha na conversa.
  // Sem não-lidas, sem reabrir, sem automação nem IA.
  if (outbound) {
    await db
      .from('conversations')
      .update({
        last_message_text: contentText,
        last_message_at: message.timestamp,
        updated_at: new Date().toISOString(),
      })
      .eq('id', resolved.conversationId);
    return NextResponse.json({ ok: true, outbound: true });
  }

  // Conversa reaberta + contadores. Mensagem nova de cliente sempre
  // reabre um atendimento fechado, igual ao canal oficial.
  const { data: current } = await db
    .from('conversations')
    .select('id, status, unread_count')
    .eq('id', resolved.conversationId)
    .maybeSingle();

  if (current) await reopenClosedConversation(db, current);

  await db
    .from('conversations')
    .update({
      last_message_text: contentText,
      last_message_at: message.timestamp,
      unread_count: ((current?.unread_count as number) ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', resolved.conversationId);

  // Fan-out depois da resposta, dentro de `after()`: o Evolution corta a
  // conexão em poucos segundos e uma resposta lenta vira reentrega —
  // que, sem o insert idempotente acima, seria mensagem duplicada.
  after(async () => {
    // Mesmos gatilhos que o canal oficial dispara para texto de
    // cliente. `interactive_reply` não entra: não existe botão aqui.
    const triggers: (
      'new_contact_created' | 'new_message_received' | 'keyword_match'
    )[] = ['new_message_received', 'keyword_match'];
    if (resolved.contactCreated) triggers.unshift('new_contact_created');

    for (const triggerType of triggers) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: resolved.contactId,
        context: {
          message_text: contentText ?? '',
          conversation_id: resolved.conversationId,
        },
      }).catch((err) =>
        console.error('[evolution-webhook] automation dispatch failed:', err)
      );
    }

    // Auto-resposta de IA — o motivo principal deste canal existir para
    // o receptivo. Só para texto de verdade; `dispatchInboundToAiReply`
    // tem os próprios portões (conta habilitada, teto por conversa) e
    // não lança.
    if (message.text && message.text.trim()) {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: resolved.conversationId,
        contactId: resolved.contactId,
        configOwnerUserId: channel.user_id as string,
      });
    }

    await dispatchWebhookEvent(db, accountId, 'message.received', {
      conversation_id: resolved.conversationId,
      contact_id: resolved.contactId,
      whatsapp_message_id: message.providerMessageId,
      content_type: message.contentType,
      text: contentText,
    });
  });

  return NextResponse.json({ ok: true });
}
