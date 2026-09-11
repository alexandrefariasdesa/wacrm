import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EvolutionError,
  connectionState,
  ensureInstance,
  sendMedia,
  sendText,
  toEvolutionNumber,
} from './evolution';

const AUTH = {
  baseUrl: 'https://evo.example.com/',
  instance: 'receptivo',
  apiKey: 'secret-key',
} as const;

/** Última chamada ao fetch, decomposta para asserção. */
function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

function okResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe('toEvolutionNumber', () => {
  it('strips everything that is not a digit', () => {
    expect(toEvolutionNumber('+55 (83) 93345-5551')).toBe('5583933455551');
  });
});

describe('sendText', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse({ key: { id: 'EVO123' } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the v2 body shape and returns the provider message id', async () => {
    const result = await sendText(AUTH, {
      to: '+55 83 93345-5551',
      text: 'oi',
    });

    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://evo.example.com/message/sendText/receptivo');
    expect(call.method).toBe('POST');
    expect(call.headers.apikey).toBe('secret-key');
    // v2: `text` na raiz. A v1 usava `textMessage: { text }`.
    expect(call.body).toEqual({ number: '5583933455551', text: 'oi' });
    expect(result.messageId).toBe('EVO123');
  });

  it('does not double the slash when baseUrl ends in one', async () => {
    await sendText(AUTH, { to: '5511999999999', text: 'oi' });
    expect(lastCall(fetchMock).url).not.toContain('//message');
  });

  it('carries a quoted message when replying', async () => {
    await sendText(AUTH, {
      to: '5511999999999',
      text: 'oi',
      quotedMessageId: 'ABC',
    });
    expect(lastCall(fetchMock).body.quoted).toEqual({ key: { id: 'ABC' } });
  });

  it('returns a null id when the provider omits the key', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const result = await sendText(AUTH, { to: '5511999999999', text: 'oi' });
    expect(result.messageId).toBeNull();
  });

  it('raises EvolutionError with the status on a 4xx', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'nope' }, 401));
    await expect(
      sendText(AUTH, { to: '5511999999999', text: 'oi' })
    ).rejects.toMatchObject({ name: 'EvolutionError', status: 401 });
  });

  it('raises EvolutionError with a null status when the server is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const error = await sendText(AUTH, {
      to: '5511999999999',
      text: 'oi',
    }).catch((e) => e);
    expect(error).toBeInstanceOf(EvolutionError);
    expect(error.status).toBeNull();
    expect(error.message).toContain('unreachable');
  });
});

describe('sendMedia', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse({ key: { id: 'EVO456' } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends image/video/document through sendMedia with caption and filename', async () => {
    await sendMedia(AUTH, {
      to: '5511999999999',
      kind: 'document',
      link: 'https://cdn.example.com/f.pdf',
      caption: 'segue',
      filename: 'contrato.pdf',
    });

    const call = lastCall(fetchMock);
    expect(call.url).toContain('/message/sendMedia/receptivo');
    expect(call.body).toEqual({
      number: '5511999999999',
      mediatype: 'document',
      media: 'https://cdn.example.com/f.pdf',
      caption: 'segue',
      fileName: 'contrato.pdf',
    });
  });

  it('routes audio to sendWhatsAppAudio and drops caption/filename', async () => {
    await sendMedia(AUTH, {
      to: '5511999999999',
      kind: 'audio',
      link: 'https://cdn.example.com/a.ogg',
      caption: 'ignorada',
      filename: 'ignorado.ogg',
    });

    const call = lastCall(fetchMock);
    expect(call.url).toContain('/message/sendWhatsAppAudio/receptivo');
    expect(call.body).toEqual({
      number: '5511999999999',
      audio: 'https://cdn.example.com/a.ogg',
    });
  });
});

describe('connectionState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['open', 'open'],
    ['connecting', 'connecting'],
    ['close', 'close'],
    ['whatever-new-state', 'close'],
    [undefined, 'close'],
  ])('maps %s to %s', async (state, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ instance: { state } }))
    );
    await expect(connectionState(AUTH)).resolves.toBe(expected);
  });
});

describe('ensureInstance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites the webhook when the instance already exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ error: 'name in use' }, 403))
      .mockResolvedValueOnce(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await ensureInstance(AUTH, 'https://crm.example.com/hook');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const call = lastCall(fetchMock);
    expect(call.url).toContain('/webhook/set/receptivo');
    expect(call.body.webhook.url).toBe('https://crm.example.com/hook');
    expect(call.body.webhook.events).toEqual([
      'MESSAGES_UPSERT',
      'CONNECTION_UPDATE',
    ]);
  });

  it('propagates a server error that is not a name clash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ error: 'boom' }, 500))
    );
    await expect(
      ensureInstance(AUTH, 'https://crm.example.com/hook')
    ).rejects.toMatchObject({ status: 500 });
  });
});
