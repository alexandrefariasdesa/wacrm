// ============================================================
// Transição de saúde do canal — ponto ÚNICO que decide "vale avisar".
//
// Duas fontes reportam o estado do canal: o evento `connection.update`
// do webhook e o vigia periódico (cron). Se cada uma avisasse por conta
// própria, a mesma queda geraria dois alertas — e, pior, se o evento
// nunca chegasse, não haveria nenhum. Aqui as duas passam pelo mesmo
// update condicional: só quem de fato muda `health_state` avisa.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Channel } from '@/lib/whatsapp/channels';
import { notifyChannelEvent } from '@/lib/whatsapp/channel-alert';
import { reconcileEvolutionChannel } from '@/lib/whatsapp/providers/evolution-reconcile';

export type ObservedHealth = 'up' | 'down';

export type ChannelWithHealth = Channel & {
  health_state?: string | null;
  health_changed_at?: string | null;
  down_reminded_at?: string | null;
  silence_alerted_at?: string | null;
};

export interface HealthTransition {
  kind: 'went_down' | 'came_back' | 'first_seen' | 'unchanged';
  /** Trabalho assíncrono (aviso, reconciliação) para rodar em `after()`. */
  followUp: (() => Promise<void>) | null;
}

export function channelLabel(
  channel: Pick<Channel, 'label' | 'display_number'>
): string {
  return channel.label || channel.display_number || 'WhatsApp';
}

export function humanDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.round(h / 24)} dias`;
}

/**
 * Registra o estado observado e devolve o que fazer depois.
 * `reason` entra no texto do aviso de queda.
 */
export async function applyChannelHealth(
  db: SupabaseClient,
  channel: ChannelWithHealth,
  observed: ObservedHealth,
  reason = ''
): Promise<HealthTransition> {
  const previous = (channel.health_state ?? 'unknown') as
    | 'unknown'
    | 'up'
    | 'down';
  if (previous === observed) {
    // O webhook grava `status = 'connecting'` em toda reconexão do Baileys
    // sem mexer em `health_state`. Quando o `open` seguinte chega o estado
    // já é `up` e nada devolvia o espelho para `connected` — a inbox lia
    // `status !== 'connected'` e mostrava o número como desconectado até
    // alguém abrir as Configurações. Repara aqui, sem avisar ninguém:
    // para a saúde do canal nada mudou.
    const mirrored = (channel as { status?: string | null }).status;
    if (observed === 'up' && mirrored && mirrored !== 'connected') {
      await db
        .from('whatsapp_config')
        .update({ status: 'connected', updated_at: new Date().toISOString() })
        .eq('id', channel.id);
    }
    return { kind: 'unchanged', followUp: null };
  }

  const now = new Date().toISOString();
  // `.eq('health_state', previous)` é a trava de corrida: se o webhook e
  // o vigia leram o mesmo estado antigo, só um update casa — o outro
  // volta vazio e não avisa.
  const { data: won } = await db
    .from('whatsapp_config')
    .update({
      health_state: observed,
      health_changed_at: now,
      down_reminded_at: null,
      status: observed === 'up' ? 'connected' : 'disconnected',
      ...(observed === 'up' ? { connected_at: now } : {}),
      updated_at: now,
    })
    .eq('id', channel.id)
    .eq('health_state', previous)
    .select('id');

  if (!won || won.length === 0) return { kind: 'unchanged', followUp: null };

  const label = channelLabel(channel);

  if (observed === 'down') {
    return {
      kind: 'went_down',
      followUp: async () => {
        await notifyChannelEvent(
          `⚠️ WhatsApp DESCONECTADO — ${label}`,
          `O número saiu do ar${reason ? ` (${reason})` : ''}. Enquanto estiver fora, nenhuma mensagem chega ao CRM.\n\nAbra Configurações > WhatsApp e leia o QR de novo o quanto antes.`,
          `down-${channel.id}-${now.slice(0, 16)}`
        );
      },
    };
  }

  // observed === 'up'
  if (previous === 'unknown') {
    // Primeira leitura e já está conectado: nada a avisar.
    return { kind: 'first_seen', followUp: null };
  }

  const downFor = channel.health_changed_at
    ? Date.now() - new Date(channel.health_changed_at).getTime()
    : null;

  return {
    kind: 'came_back',
    followUp: async () => {
      let summary = '';
      try {
        const r = await reconcileEvolutionChannel(db, channel);
        summary = `${r.inserted} mensagem(ns) recuperada(s) do período desde ${r.since}.`;
      } catch (err) {
        console.error('[channel-health] reconcile failed:', err);
        summary = 'Não consegui reconciliar as mensagens do período.';
      }
      await notifyChannelEvent(
        `✅ WhatsApp VOLTOU — ${label}`,
        `${downFor ? `Ficou fora por ${humanDuration(downFor)}. ` : ''}${summary}\n\nSe houve QR novo, mensagens trocadas só no celular durante a queda podem não aparecer no CRM.`,
        `up-${channel.id}-${now.slice(0, 16)}`
      );
    },
  };
}
