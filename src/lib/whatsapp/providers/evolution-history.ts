// ============================================================
// Importação de histórico do canal NÃO-OFICIAL (Evolution API).
//
// Dois caminhos desembocam aqui, e os dois trazem mensagem que o CRM
// perdeu enquanto a sessão estava fora:
//
//  1. `messages.set` — o lote que o WhatsApp entrega ao parear um QR novo
//     (quando a sessão é deslogada, o aparelho vinculado é refeito e o
//     histórico só vem nesse momento).
//  2. Reconciliação ao reconectar — pergunta ao Evolution o que ele
//     recebeu desde a última mensagem que o CRM tem.
//
// Diferença para o receptor em tempo real: aqui a mensagem é ANTIGA.
// Logo, nada de automação, nada de resposta de IA, nada de webhook de
// saída — responder a uma pergunta de quatro dias atrás como se tivesse
// acabado de chegar seria pior do que não importar. O que entra é a
// conversa com a data original, e o contador de não lidas só considera
// o que ficou SEM resposta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';

import type { InboundEvolutionMessage } from './evolution-inbound';

export interface HistoryImportResult {
  /** Mensagens recebidas para importar (com id do provedor). */
  received: number;
  /** Linhas realmente criadas — o resto já existia. */
  inserted: number;
  /** Conversas tocadas. */
  conversations: number;
  /** Conversas que falharam (o resto do lote segue). */
  failed: number;
}

interface ChannelRef {
  id: string;
  account_id: string;
}

/** Mensagem em formato de linha de `messages`, para o upsert em lote. */
function toRow(
  m: InboundEvolutionMessage,
  conversationId: string,
  channelId: string
) {
  const outbound = m.direction === 'outbound';
  const contentText =
    m.text ?? (m.contentType === 'unknown' ? null : `[${m.contentType}]`);
  return {
    conversation_id: conversationId,
    sender_type: outbound ? 'agent' : 'customer',
    content_type: m.contentType === 'unknown' ? 'text' : m.contentType,
    content_text: contentText,
    message_id: m.providerMessageId,
    channel_id: channelId,
    status: outbound ? 'sent' : 'delivered',
    created_at: m.timestamp,
  };
}

/**
 * Importa um lote de mensagens antigas. Idempotente: o índice único
 * `(conversation_id, message_id)` da migration 037 faz a repetição virar
 * no-op, então reentregar o mesmo lote não duplica nada.
 */
export async function importEvolutionHistory(
  db: SupabaseClient,
  channel: ChannelRef,
  messages: InboundEvolutionMessage[]
): Promise<HistoryImportResult> {
  const result: HistoryImportResult = {
    received: 0,
    inserted: 0,
    conversations: 0,
    failed: 0,
  };

  // Sem id do provedor não há como deduplicar — importar duplicaria a
  // bolha a cada reentrega.
  const usable = messages.filter((m) => m.providerMessageId);
  result.received = usable.length;

  const byPhone = new Map<string, InboundEvolutionMessage[]>();
  for (const m of usable) {
    const list = byPhone.get(m.phone) ?? [];
    list.push(m);
    byPhone.set(m.phone, list);
  }

  for (const [phone, list] of byPhone) {
    try {
      list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      // O nome de perfil só vale quando vem do CLIENTE; nas mensagens
      // nossas o `pushName` é o do próprio número.
      const clientName =
        [...list].reverse().find((m) => m.direction === 'inbound')?.pushName ??
        null;

      const resolved = await resolveConversationByPhone(
        db,
        channel.account_id,
        `+${phone}`,
        clientName,
        channel.id
      );

      const { data: before } = await db
        .from('conversations')
        .select('id, status, unread_count, last_message_at')
        .eq('id', resolved.conversationId)
        .maybeSingle();

      const rows = list.map((m) => toRow(m, resolved.conversationId, channel.id));
      const { data: insertedRows, error } = await db
        .from('messages')
        .upsert(rows, {
          onConflict: 'conversation_id,message_id',
          ignoreDuplicates: true,
        })
        .select('message_id, sender_type, created_at');

      if (error) throw error;
      const inserted = (insertedRows ?? []) as {
        message_id: string;
        sender_type: string;
        created_at: string;
      }[];
      result.inserted += inserted.length;
      result.conversations += 1;
      if (inserted.length === 0) continue;

      // Última mensagem da conversa: só avança, nunca recua. Importar
      // histórico não pode fazer a conversa "voltar no tempo".
      const newest = list[list.length - 1];
      const prevAt = (before?.last_message_at as string | null) ?? null;
      const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (!prevAt || newest.timestamp > prevAt) {
        update.last_message_text =
          newest.text ??
          (newest.contentType === 'unknown' ? null : `[${newest.contentType}]`);
        update.last_message_at = newest.timestamp;
      }

      // Não lidas = mensagens do cliente DEPOIS da última nossa resposta
      // (e depois do que a conversa já tinha). Histórico antigo já
      // respondido não deve acender nada.
      const lastOutboundAt = inserted
        .filter((r) => r.sender_type === 'agent')
        .map((r) => r.created_at)
        .sort()
        .pop();
      const floor = [prevAt, lastOutboundAt]
        .filter((v): v is string => !!v)
        .sort()
        .pop();
      const unanswered = inserted.filter(
        (r) =>
          r.sender_type === 'customer' && (!floor || r.created_at > floor)
      ).length;
      if (unanswered > 0) {
        update.unread_count = ((before?.unread_count as number) ?? 0) + unanswered;
      }

      await db
        .from('conversations')
        .update(update)
        .eq('id', resolved.conversationId);

      if (unanswered > 0 && before) {
        await reopenClosedConversation(db, before);
      }
    } catch (err) {
      result.failed += 1;
      console.error(`[evolution-history] import failed for ${phone}:`, err);
    }
  }

  return result;
}
