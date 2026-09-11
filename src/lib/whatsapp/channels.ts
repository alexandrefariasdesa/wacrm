// ============================================================
// Canais de WhatsApp — resolução e credenciais.
//
// A conta deixou de ter "a" conexão do WhatsApp (migration 043) e passou
// a ter uma por TIPO:
//
//   cloud_api   número na API oficial da Meta. É o único que envia
//               template, e portanto o único que dispara em massa.
//   unofficial  número pareado por QR num Evolution API. Serve o
//               receptivo; não tem template, não tem `referral` de
//               anúncio, e disparo em massa por aqui queima o número.
//
// Antes disto, todo call site fazia `.eq('account_id', …).single()` em
// `whatsapp_config`. Com duas linhas na tabela esse `.single()` passa a
// ERRAR ("multiple rows returned") — ou seja, o segundo canal quebraria
// o envio inteiro em silêncio. Por isso a resolução mora aqui, num lugar
// só, e os call sites dizem qual canal querem.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';

export const CHANNEL_KINDS = ['cloud_api', 'unofficial'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Uma linha de `whatsapp_config` — um canal. */
export interface Channel {
  id: string;
  account_id: string;
  user_id: string;
  kind: ChannelKind;
  label: string | null;
  display_number: string | null;
  status: 'connected' | 'disconnected' | 'connecting';
  /** Cloud API */
  phone_number_id: string | null;
  waba_id: string | null;
  access_token: string | null;
  /** Evolution API */
  provider_base_url: string | null;
  provider_instance: string | null;
  provider_api_key: string | null;
  webhook_secret: string | null;
}

export class ChannelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
  }
}

/** Todos os canais da conta, oficial primeiro. */
export async function listChannels(
  db: SupabaseClient,
  accountId: string
): Promise<Channel[]> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('kind', { ascending: true });

  if (error) {
    throw new ChannelError('channel_lookup_failed', error.message);
  }
  return (data ?? []) as Channel[];
}

/**
 * O canal de um tipo, ou null. `maybeSingle()` e não `single()`: conta
 * sem canal configurado é estado normal (instalação nova), não erro.
 */
export async function loadChannelByKind(
  db: SupabaseClient,
  accountId: string,
  kind: ChannelKind
): Promise<Channel | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('kind', kind)
    .maybeSingle();

  if (error) {
    throw new ChannelError('channel_lookup_failed', error.message);
  }
  return (data as Channel) ?? null;
}

/** Um canal específico, sempre com escopo de conta. */
export async function loadChannelById(
  db: SupabaseClient,
  accountId: string,
  channelId: string
): Promise<Channel | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', channelId)
    .maybeSingle();

  if (error) {
    throw new ChannelError('channel_lookup_failed', error.message);
  }
  return (data as Channel) ?? null;
}

/**
 * Por onde uma resposta desta conversa tem de sair.
 *
 * A regra é uma só, e não é configurável de propósito: **responde-se
 * pelo canal por onde a conversa entrou**. O cliente escreveu para um
 * número; a resposta tem de vir daquele número, senão ela chega de um
 * remetente desconhecido — e, no caso do não-oficial, nem chega na mesma
 * thread do aparelho dele.
 *
 * `channel_id` nulo é conversa anterior ao multicanal (ou canal
 * removido): cai no oficial, que era o único que existia.
 */
export async function resolveOutboundChannel(
  db: SupabaseClient,
  accountId: string,
  conversationChannelId: string | null
): Promise<Channel> {
  const channel = conversationChannelId
    ? await loadChannelById(db, accountId, conversationChannelId)
    : null;

  const resolved =
    channel ?? (await loadChannelByKind(db, accountId, 'cloud_api'));

  if (!resolved) {
    throw new ChannelError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.'
    );
  }
  return resolved;
}

/**
 * Credenciais da Cloud API, decifradas. Estreita o canal para o tipo
 * certo — chamar isto com um canal não-oficial é bug de programação, não
 * erro de usuário, então a mensagem diz exatamente isso.
 */
export function cloudApiCredentials(channel: Channel): {
  phoneNumberId: string;
  accessToken: string;
  wabaId: string | null;
} {
  if (channel.kind !== 'cloud_api') {
    throw new ChannelError(
      'wrong_channel_kind',
      `Channel ${channel.id} is '${channel.kind}', not a Cloud API channel`
    );
  }
  // O CHECK da migration 043 garante os dois preenchidos quando
  // kind='cloud_api'; o guard aqui é para o TypeScript e para o caso de
  // alguém escrever na tabela por fora.
  if (!channel.phone_number_id || !channel.access_token) {
    throw new ChannelError(
      'whatsapp_not_configured',
      'Cloud API channel is missing its phone number id or access token'
    );
  }
  return {
    phoneNumberId: channel.phone_number_id,
    accessToken: decrypt(channel.access_token),
    wabaId: channel.waba_id,
  };
}

/** Credenciais do Evolution API, decifradas. */
export function evolutionCredentials(channel: Channel): {
  baseUrl: string;
  instance: string;
  apiKey: string;
} {
  if (channel.kind !== 'unofficial') {
    throw new ChannelError(
      'wrong_channel_kind',
      `Channel ${channel.id} is '${channel.kind}', not an unofficial channel`
    );
  }
  if (!channel.provider_base_url || !channel.provider_instance) {
    throw new ChannelError(
      'whatsapp_not_configured',
      'Unofficial channel is missing its provider URL or instance name'
    );
  }
  return {
    baseUrl: channel.provider_base_url.replace(/\/$/, ''),
    instance: channel.provider_instance,
    apiKey: channel.provider_api_key ? decrypt(channel.provider_api_key) : '',
  };
}

/**
 * Recurso que só existe na API oficial (template, broadcast, mídia por
 * media id, registro do número). Chamado pelas rotas que hoje faziam
 * `.single()` sem filtro: elas passam a pedir o canal oficial
 * explicitamente e a dar um erro claro quando ele não existe.
 */
export async function requireCloudApiChannel(
  db: SupabaseClient,
  accountId: string
): Promise<Channel> {
  const channel = await loadChannelByKind(db, accountId, 'cloud_api');
  if (!channel) {
    throw new ChannelError(
      'cloud_api_not_configured',
      'This feature requires the official WhatsApp Business API channel.'
    );
  }
  return channel;
}
