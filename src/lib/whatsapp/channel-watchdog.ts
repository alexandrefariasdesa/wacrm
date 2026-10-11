// ============================================================
// Vigia dos canais não-oficiais (roda por cron, a cada poucos minutos).
//
// Não confia no evento `connection.update`: se ele nunca chegar ao
// wacrm (webhook fora do ar, Evolution reiniciando), o CRM ficaria
// "conectado" para uma sessão morta. O vigia pergunta ao Evolution o
// estado REAL e passa pelo mesmo `applyChannelHealth` do webhook.
//
// Além de queda e volta, faz dois avisos que só um relógio consegue:
//   - lembrete: continua fora depois de 30 min (e a cada 6 h);
//   - silêncio: conectado, em horário comercial, mas sem NENHUMA mensagem
//     de cliente há N horas — o caso "conectado, porém surdo".
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { evolutionCredentials, type Channel } from '@/lib/whatsapp/channels';
import { notifyChannelEvent } from '@/lib/whatsapp/channel-alert';
import {
  applyChannelHealth,
  channelLabel,
  humanDuration,
  type ChannelWithHealth,
} from '@/lib/whatsapp/channel-health';
import { connectionState } from '@/lib/whatsapp/providers/evolution';

const REMINDER_AFTER_MS = 30 * 60 * 1000;
const REMINDER_EVERY_MS = 6 * 60 * 60 * 1000;
const SILENCE_REPEAT_MS = 24 * 60 * 60 * 1000;

/** Janela em que silêncio é suspeito (hora local de Manaus). */
const BUSINESS_TZ = 'America/Manaus';
const BUSINESS_START = 8;
const BUSINESS_END = 21;

export function isBusinessHours(now: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: BUSINESS_TZ,
    }).format(now)
  );
  return hour >= BUSINESS_START && hour < BUSINESS_END;
}

export interface WatchdogItem {
  channel_id: string;
  observed: 'up' | 'down' | 'skipped';
  transition: string;
  silence?: boolean;
  reminder?: boolean;
  note?: string;
}

export async function runChannelWatchdog(
  db: SupabaseClient,
  opts: { now?: Date; silenceHours?: number } = {}
): Promise<WatchdogItem[]> {
  const now = opts.now ?? new Date();
  const silenceHours =
    opts.silenceHours ?? Number(process.env.WHATSAPP_SILENCE_HOURS ?? 8);

  const { data: channels, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('kind', 'unofficial')
    .not('provider_base_url', 'is', null);
  if (error) throw error;

  const items: WatchdogItem[] = [];

  for (const raw of (channels ?? []) as ChannelWithHealth[]) {
    const channel = raw as ChannelWithHealth & Channel;
    const item: WatchdogItem = {
      channel_id: channel.id,
      observed: 'skipped',
      transition: 'unchanged',
    };
    items.push(item);

    // ---- estado real ---------------------------------------------
    let state: 'open' | 'connecting' | 'close' | 'unreachable';
    try {
      state = await connectionState(evolutionCredentials(channel));
    } catch (err) {
      console.error('[channel-watchdog] provider unreachable:', err);
      state = 'unreachable';
    }

    // `connecting` é reconexão em curso: só vira queda se o canal já
    // estava marcado como fora (não inventa queda por um instante).
    if (state === 'connecting' && channel.health_state !== 'down') {
      item.note = 'connecting';
      continue;
    }

    const observed: 'up' | 'down' = state === 'open' ? 'up' : 'down';
    item.observed = observed;

    const reason =
      state === 'unreachable'
        ? 'o servidor do WhatsApp não respondeu'
        : 'a sessão do WhatsApp está encerrada';
    const transition = await applyChannelHealth(db, channel, observed, reason);
    item.transition = transition.kind;
    if (transition.followUp) await transition.followUp();

    const label = channelLabel(channel);

    // ---- lembrete de queda prolongada -----------------------------
    if (observed === 'down') {
      const changedAt = channel.health_changed_at
        ? new Date(channel.health_changed_at).getTime()
        : now.getTime();
      const downFor = now.getTime() - changedAt;
      const last = channel.down_reminded_at
        ? new Date(channel.down_reminded_at).getTime()
        : 0;
      if (
        transition.kind === 'unchanged' &&
        downFor >= REMINDER_AFTER_MS &&
        now.getTime() - last >= REMINDER_EVERY_MS
      ) {
        await db
          .from('whatsapp_config')
          .update({ down_reminded_at: now.toISOString() })
          .eq('id', channel.id);
        await notifyChannelEvent(
          `⏰ WhatsApp continua DESCONECTADO — ${label}`,
          `Está fora há ${humanDuration(downFor)}. Cada hora assim é mensagem de cliente que não entra no CRM.\n\nLeia o QR em Configurações > WhatsApp.`,
          `remind-${channel.id}-${now.toISOString().slice(0, 13)}`
        );
        item.reminder = true;
      }
      continue;
    }

    // ---- silêncio suspeito ----------------------------------------
    if (!isBusinessHours(now)) continue;
    // Recém-reconectado não tem histórico recente por definição.
    if (transition.kind === 'came_back' || transition.kind === 'first_seen') {
      continue;
    }

    const { data: lastIn } = await db
      .from('messages')
      .select('created_at')
      .eq('channel_id', channel.id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastIn?.created_at) continue;
    const quietFor = now.getTime() - new Date(lastIn.created_at as string).getTime();
    if (quietFor < silenceHours * 60 * 60 * 1000) continue;

    const alerted = channel.silence_alerted_at
      ? new Date(channel.silence_alerted_at).getTime()
      : 0;
    if (now.getTime() - alerted < SILENCE_REPEAT_MS) continue;

    await db
      .from('whatsapp_config')
      .update({ silence_alerted_at: now.toISOString() })
      .eq('id', channel.id);
    await notifyChannelEvent(
      `🔇 WhatsApp conectado, mas sem mensagens — ${label}`,
      `Nenhuma mensagem de cliente há ${humanDuration(quietFor)} em horário comercial, e a sessão aparece como conectada. Pode ser um dia calmo, ou a sessão estar surda.\n\nConfira mandando uma mensagem de outro número para este.`,
      `silence-${channel.id}-${now.toISOString().slice(0, 10)}`
    );
    item.silence = true;
  }

  return items;
}
