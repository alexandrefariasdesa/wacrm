// ============================================================
// Reconciliação ao reconectar (canal NÃO-OFICIAL).
//
// Quando a sessão volta, perguntamos ao Evolution o que ele recebeu
// desde a última mensagem que o CRM tem e importamos o que faltou. Cobre
// o webhook que falhou, o wacrm fora do ar e a queda curta.
//
// Limite que não dá para contornar: o Evolution só tem o que a sessão
// viu. O que aconteceu com o número deslogado não está lá — isso só
// volta pelo histórico do pareamento (`messages.set`).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { evolutionCredentials, type Channel } from '@/lib/whatsapp/channels';

import { findMessagesSince } from './evolution';
import { importEvolutionHistory, type HistoryImportResult } from './evolution-history';
import { parseMessageData } from './evolution-inbound';

const MARGIN_MS = 10 * 60 * 1000;
const FALLBACK_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export async function reconcileEvolutionChannel(
  db: SupabaseClient,
  channel: Channel
): Promise<HistoryImportResult & { since: string; fetched: number }> {
  const { data: last } = await db
    .from('messages')
    .select('created_at')
    .eq('channel_id', channel.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const base = last?.created_at
    ? new Date(last.created_at as string).getTime()
    : Date.now() - FALLBACK_WINDOW_MS;
  const since = new Date(base - MARGIN_MS).toISOString();

  const raw = await findMessagesSince(evolutionCredentials(channel), since);

  const parsed = raw
    .map((r) =>
      parseMessageData(
        r as Parameters<typeof parseMessageData>[0],
        channel.provider_instance ?? null
      )
    )
    .flatMap((p) => (p.ok ? [p.message] : []));

  const result = await importEvolutionHistory(
    db,
    { id: channel.id, account_id: channel.account_id },
    parsed
  );
  return { ...result, since, fetched: raw.length };
}
