// ============================================================
// Tradução do webhook do Evolution API para o formato interno.
//
// Puro de propósito: nada de I/O aqui. O parse do payload de terceiro é
// exatamente o pedaço que precisa de teste barato e exaustivo — o
// Evolution muda de forma entre versões, e um campo que muda de lugar
// não pode virar mensagem perdida em silêncio.
//
// A rota (`/api/whatsapp/webhook/evolution`) faz o I/O; este arquivo só
// responde "o que é este evento, e o que dele nos interessa?".
// ============================================================

/** O que decidimos fazer com um evento recebido. */
export type EvolutionEvent =
  | { kind: 'message'; message: InboundEvolutionMessage }
  | { kind: 'connection'; state: 'open' | 'connecting' | 'close' }
  /**
   * Lote de histórico (`messages.set`): o que o WhatsApp entrega ao
   * pareamento. Entra na conversa com a data original e SEM efeito
   * colateral — nada de automação, IA ou aviso de mensagem nova.
   */
  | { kind: 'history'; messages: InboundEvolutionMessage[]; skipped: number }
  | { kind: 'ignored'; reason: string };

export interface InboundEvolutionMessage {
  /** Telefone do cliente, só dígitos (do JID). */
  phone: string;
  /** Nome que o WhatsApp expõe no perfil, quando vem. */
  pushName: string | null;
  /** Id da mensagem no provedor — dedupe de reentrega. */
  providerMessageId: string | null;
  /** Texto, quando é mensagem de texto. */
  text: string | null;
  /** Tipo mapeado para o vocabulário do CRM. */
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'unknown';
  /** Instante da mensagem em ISO, do carimbo do provedor. */
  timestamp: string;
  /** Nome da instância que recebeu — é o que amarra ao canal. */
  instance: string | null;
  /**
   * `outbound` = enviada pelo próprio número (celular ou WhatsApp Web).
   * O eco do que o CRM mandou chega igual; quem distingue é o dedupe por
   * `providerMessageId`.
   */
  direction: 'inbound' | 'outbound';
}

interface EvolutionKey {
  remoteJid?: string;
  /**
   * Com endereçamento por LID (`addressingMode: 'lid'`) o `remoteJid` vem
   * como `…@lid` — um identificador interno, sem telefone — e o número
   * real fica aqui. Sessões pareadas há pouco usam LID em quase tudo.
   */
  remoteJidAlt?: string;
  fromMe?: boolean;
  id?: string;
}

interface EvolutionMessageBody {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  documentMessage?: { caption?: string; fileName?: string };
  audioMessage?: unknown;
  // Toque em botão. Quem dispara template com botão por este número recebe
  // a resposta nestes formatos, e para o lead tocar em "VER DETALHES" é a
  // PRIMEIRA mensagem dele — descartá-la sumia com o lead inteiro.
  templateButtonReplyMessage?: { selectedDisplayText?: string; selectedId?: string };
  buttonsResponseMessage?: { selectedDisplayText?: string; selectedButtonId?: string };
  listResponseMessage?: {
    title?: string;
    singleSelectReply?: { selectedRowId?: string };
  };
  interactiveResponseMessage?: { body?: { text?: string } };
  [k: string]: unknown;
}

/** Texto do botão/opção escolhido, quando a mensagem é um toque em botão. */
function replyTextOf(body: EvolutionMessageBody): string | null {
  return (
    body.templateButtonReplyMessage?.selectedDisplayText ??
    body.templateButtonReplyMessage?.selectedId ??
    body.buttonsResponseMessage?.selectedDisplayText ??
    body.buttonsResponseMessage?.selectedButtonId ??
    body.listResponseMessage?.title ??
    body.listResponseMessage?.singleSelectReply?.selectedRowId ??
    body.interactiveResponseMessage?.body?.text ??
    null
  );
}

interface EvolutionMessageData {
  key?: EvolutionKey;
  pushName?: string;
  message?: EvolutionMessageBody;
  messageTimestamp?: number | string;
  state?: string;
  [k: string]: unknown;
}

interface EvolutionWebhookPayload {
  event?: string;
  instance?: string;
  /** Objeto num evento só; lista no `messages.set` (histórico). */
  data?: EvolutionMessageData | EvolutionMessageData[];
}

/** Telefone a partir do JID (`5583933455551@s.whatsapp.net`). */
export function phoneFromJid(jid: string): string | null {
  const [user] = jid.split('@');
  const digits = (user ?? '').split(':')[0].replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

/** Grupo, canal e status não são atendimento 1-a-1 — ficam de fora. */
export function isIndividualJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us');
}

function contentTypeOf(
  body: EvolutionMessageBody | undefined
): InboundEvolutionMessage['contentType'] {
  if (!body) return 'unknown';
  if (body.conversation || body.extendedTextMessage) return 'text';
  if (replyTextOf(body)) return 'text';
  if (body.imageMessage) return 'image';
  if (body.videoMessage) return 'video';
  if (body.audioMessage) return 'audio';
  if (body.documentMessage) return 'document';
  return 'unknown';
}

function textOf(body: EvolutionMessageBody | undefined): string | null {
  if (!body) return null;
  return (
    body.conversation ??
    body.extendedTextMessage?.text ??
    body.imageMessage?.caption ??
    body.videoMessage?.caption ??
    body.documentMessage?.caption ??
    replyTextOf(body)
  );
}

/**
 * Carimbo do provedor em ISO.
 *
 * O Evolution manda `messageTimestamp` em SEGUNDOS (epoch do WhatsApp),
 * não em milissegundos. Multiplicar errado joga a mensagem para 1970 e
 * ela nasce no fim da lista da inbox — por isso a conversão é explícita,
 * e um valor ausente ou absurdo cai para "agora" em vez de para uma data
 * inventada.
 */
export function timestampToIso(
  raw: number | string | undefined,
  now: () => number = Date.now
): string {
  const seconds = typeof raw === 'string' ? Number(raw) : raw;
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return new Date(now()).toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

/**
 * Classifica um evento do Evolution.
 *
 * `fromMe` é o caso que mais importa acertar: toda mensagem que NÓS
 * enviamos volta pelo webhook com essa marca — inclusive as digitadas
 * direto no celular/WhatsApp Web, que o CRM não conhece. Elas viram
 * `direction: 'outbound'`: a rota grava como do atendente (dedupe pelo id
 * do provedor evita duplicar o que o CRM mesmo enviou) e NÃO dispara
 * automação nem auto-resposta da IA.
 */
export function classifyEvolutionEvent(
  payload: EvolutionWebhookPayload
): EvolutionEvent {
  const event = (payload.event ?? '').toLowerCase().replace(/_/g, '.');
  const data = payload.data;

  if (event === 'connection.update') {
    const raw = String(
      (Array.isArray(data) ? undefined : data?.state) ?? ''
    );
    const state =
      raw === 'open' || raw === 'connecting' || raw === 'close' ? raw : 'close';
    return { kind: 'connection', state };
  }

  if (event === 'messages.set') {
    const list = Array.isArray(data) ? data : [];
    const messages: InboundEvolutionMessage[] = [];
    let skipped = 0;
    for (const item of list) {
      const parsed = parseMessageData(item, payload.instance ?? null);
      if (parsed.ok) messages.push(parsed.message);
      else skipped += 1;
    }
    return { kind: 'history', messages, skipped };
  }

  if (event !== 'messages.upsert') {
    return { kind: 'ignored', reason: `event "${payload.event}" not handled` };
  }

  if (!data || Array.isArray(data)) {
    return { kind: 'ignored', reason: 'no remoteJid' };
  }

  const parsed = parseMessageData(data, payload.instance ?? null);
  if (!parsed.ok) return { kind: 'ignored', reason: parsed.reason };
  return { kind: 'message', message: parsed.message };
}

/**
 * Uma mensagem do Evolution (a mesma forma em `messages.upsert`,
 * `messages.set` e `findMessages`) para o formato interno.
 */
export function parseMessageData(
  data: EvolutionMessageData | undefined,
  instance: string | null
): { ok: true; message: InboundEvolutionMessage } | { ok: false; reason: string } {
  const key = data?.key;
  // LID sem telefone não identifica ninguém no CRM; com `remoteJidAlt` o
  // número real está ali e a mensagem segue o caminho normal.
  const rawJid = key?.remoteJid ?? '';
  const jid =
    rawJid.endsWith('@lid') && key?.remoteJidAlt ? key.remoteJidAlt : rawJid;

  if (!jid) return { ok: false, reason: 'no remoteJid' };
  if (!isIndividualJid(jid)) {
    return { ok: false, reason: `not a 1:1 chat (${jid})` };
  }

  const phone = phoneFromJid(jid);
  if (!phone) return { ok: false, reason: `unparseable jid (${jid})` };

  const body = data?.message;
  const contentType = contentTypeOf(body);
  const text = textOf(body);

  // Mensagem sem texto E de tipo que não reconhecemos: normalmente é
  // reação, edição, revogação ou protocolo interno do WhatsApp. Ignorar
  // é melhor do que gravar uma bolha vazia na conversa.
  if (contentType === 'unknown' && !text) {
    return { ok: false, reason: 'no renderable content' };
  }

  return {
    ok: true,
    message: {
      phone,
      pushName: data?.pushName ?? null,
      providerMessageId: key?.id ?? null,
      text,
      contentType,
      timestamp: timestampToIso(data?.messageTimestamp),
      instance,
      direction: key?.fromMe ? 'outbound' : 'inbound',
    },
  };
}
