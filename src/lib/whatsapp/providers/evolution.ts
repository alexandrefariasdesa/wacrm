// ============================================================
// Adaptador do Evolution API — o canal NÃO-OFICIAL.
//
// O Evolution é um servidor que mantém uma sessão do WhatsApp Web
// (Baileys) pareada por QR e expõe REST para enviar + webhook para
// receber. Este arquivo é a única parte do wacrm que fala com ele.
//
// Alvo: Evolution API **v2**. A diferença de forma que mais pega, porque
// a v1 ainda é o que aparece na maioria dos tutoriais:
//   v1  POST /message/sendText/{instance}  { number, textMessage: { text } }
//   v2  POST /message/sendText/{instance}  { number, text }
// Mandamos no formato v2.
//
// O que ele NÃO tem, e por isso não está aqui: template aprovado,
// broadcast, e o `referral` de anúncio da Meta. Quem precisa disso usa
// o canal `cloud_api`.
//
// Aviso que o código não consegue dar sozinho: esta é uma conexão não
// suportada pelo WhatsApp. Volume alto, disparo em massa ou muita
// mensagem para quem nunca falou com você derrubam o número. O bloqueio
// de broadcast neste canal é proposital.
// ============================================================

/** Falha do provedor, com o status HTTP quando houve resposta. */
export class EvolutionError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'EvolutionError';
    this.status = status;
  }
}

export interface EvolutionAuth {
  /** Raiz do servidor, sem barra no fim. */
  baseUrl: string;
  /** Nome da instância (a sessão pareada). */
  instance: string;
  /** Chave da API do servidor — vai no header `apikey`. */
  apiKey: string;
}

export type EvolutionState = 'open' | 'connecting' | 'close';

const REQUEST_TIMEOUT_MS = 20_000;

async function request<T>(
  auth: EvolutionAuth,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${auth.baseUrl.replace(/\/$/, '')}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: auth.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Servidor fora do ar / DNS / timeout. Diferente de um 4xx: aqui não
    // houve resposta nenhuma, e quem chamou precisa saber que a mensagem
    // pode não ter saído.
    throw new EvolutionError(
      `Evolution API unreachable at ${auth.baseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new EvolutionError(
      `Evolution API error ${response.status}: ${text.slice(0, 300)}`,
      response.status
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Número no formato que o Evolution espera: só dígitos, com código do
 * país. Ele aceita tanto `5511999999999` quanto o JID completo
 * (`5511999999999@s.whatsapp.net`); mandamos o cru e deixamos o servidor
 * montar o JID.
 */
export function toEvolutionNumber(phone: string): string {
  return phone.replace(/\D/g, '');
}

interface EvolutionSendResponse {
  key?: { id?: string };
}

/** Id da mensagem devolvido pelo provedor, ou null quando ele omite. */
function messageIdOf(data: EvolutionSendResponse): string | null {
  return data?.key?.id ?? null;
}

export async function sendText(
  auth: EvolutionAuth,
  args: { to: string; text: string; quotedMessageId?: string }
): Promise<{ messageId: string | null }> {
  const body: Record<string, unknown> = {
    number: toEvolutionNumber(args.to),
    text: args.text,
  };
  if (args.quotedMessageId) {
    body.quoted = { key: { id: args.quotedMessageId } };
  }
  const data = await request<EvolutionSendResponse>(
    auth,
    'POST',
    `/message/sendText/${encodeURIComponent(auth.instance)}`,
    body
  );
  return { messageId: messageIdOf(data) };
}

export type EvolutionMediaKind = 'image' | 'video' | 'document' | 'audio';

export async function sendMedia(
  auth: EvolutionAuth,
  args: {
    to: string;
    kind: EvolutionMediaKind;
    /** URL pública que o servidor baixa na hora do envio. */
    link: string;
    caption?: string;
    filename?: string;
  }
): Promise<{ messageId: string | null }> {
  // Áudio tem rota própria no Evolution (`sendWhatsAppAudio`) porque é o
  // que faz o WhatsApp renderizar como mensagem de voz em vez de anexo.
  // Caption e filename não existem nesse caminho.
  if (args.kind === 'audio') {
    const data = await request<EvolutionSendResponse>(
      auth,
      'POST',
      `/message/sendWhatsAppAudio/${encodeURIComponent(auth.instance)}`,
      { number: toEvolutionNumber(args.to), audio: args.link }
    );
    return { messageId: messageIdOf(data) };
  }

  const body: Record<string, unknown> = {
    number: toEvolutionNumber(args.to),
    mediatype: args.kind,
    media: args.link,
  };
  if (args.caption) body.caption = args.caption;
  if (args.filename) body.fileName = args.filename;

  const data = await request<EvolutionSendResponse>(
    auth,
    'POST',
    `/message/sendMedia/${encodeURIComponent(auth.instance)}`,
    body
  );
  return { messageId: messageIdOf(data) };
}

/** Estado da sessão. `open` = pareada e recebendo. */
export async function connectionState(
  auth: EvolutionAuth
): Promise<EvolutionState> {
  const data = await request<{ instance?: { state?: string } }>(
    auth,
    'GET',
    `/instance/connectionState/${encodeURIComponent(auth.instance)}`
  );
  const state = data?.instance?.state;
  return state === 'open' || state === 'connecting' ? state : 'close';
}

/**
 * Abre (ou reabre) o pareamento e devolve o QR em base64 para a tela de
 * configuração. Quando a sessão já está `open`, o Evolution responde sem
 * QR — devolvemos null e a UI mostra "já conectado".
 */
export async function pairingQrCode(
  auth: EvolutionAuth
): Promise<{ base64: string | null; code: string | null }> {
  const data = await request<{ base64?: string; code?: string }>(
    auth,
    'GET',
    `/instance/connect/${encodeURIComponent(auth.instance)}`
  );
  return { base64: data?.base64 ?? null, code: data?.code ?? null };
}

/**
 * Aponta o webhook da instância para o nosso receptor.
 *
 * Só `MESSAGES_UPSERT` (mensagem nova) e `CONNECTION_UPDATE` (a sessão
 * caiu ou voltou). O Evolution emite dezenas de eventos, e assinar todos
 * seria pagar parse e log de coisa que não usamos.
 */
export async function setWebhook(
  auth: EvolutionAuth,
  webhookUrl: string
): Promise<void> {
  await request(
    auth,
    'POST',
    `/webhook/set/${encodeURIComponent(auth.instance)}`,
    {
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      },
    }
  );
}

/**
 * Cria a instância se ela ainda não existir.
 *
 * O Evolution recusa nome repetido com 4xx em vez de devolver a
 * existente. Nesse caso seguimos em frente — a instância existir é
 * justamente o que queríamos —, mas reescrevemos o webhook: ela pode ter
 * sido criada por fora, apontando para outro lugar ou para lugar nenhum.
 */
export async function ensureInstance(
  auth: EvolutionAuth,
  webhookUrl: string
): Promise<void> {
  try {
    await request(auth, 'POST', '/instance/create', {
      instanceName: auth.instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      },
    });
  } catch (err) {
    const status = err instanceof EvolutionError ? err.status : null;
    if (status === 400 || status === 403 || status === 409) {
      await setWebhook(auth, webhookUrl);
      return;
    }
    throw err;
  }
}
