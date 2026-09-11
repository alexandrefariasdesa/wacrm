import { describe, expect, it } from 'vitest';

import {
  classifyEvolutionEvent,
  isIndividualJid,
  phoneFromJid,
  timestampToIso,
} from './evolution-inbound';

const JID = '5583933455551@s.whatsapp.net';

function upsert(data: Record<string, unknown>) {
  return { event: 'messages.upsert', instance: 'receptivo', data };
}

describe('phoneFromJid', () => {
  it('extracts the digits from a user JID', () => {
    expect(phoneFromJid(JID)).toBe('5583933455551');
  });

  it('drops the device suffix a multi-device JID carries', () => {
    expect(phoneFromJid('5583933455551:12@s.whatsapp.net')).toBe(
      '5583933455551'
    );
  });

  it('returns null for something too short to be a phone', () => {
    expect(phoneFromJid('123@s.whatsapp.net')).toBeNull();
  });
});

describe('isIndividualJid', () => {
  it.each([
    ['5583933455551@s.whatsapp.net', true],
    ['5583933455551@c.us', true],
    ['1203630@g.us', false],
    ['status@broadcast', false],
    ['123@newsletter', false],
  ])('%s → %s', (jid, expected) => {
    expect(isIndividualJid(jid)).toBe(expected);
  });
});

describe('timestampToIso', () => {
  it('reads the provider timestamp as SECONDS, not milliseconds', () => {
    // 1_767_225_600 = 2026-01-01T00:00:00Z. Tratado como ms, isto viraria
    // 1970 e a mensagem nasceria no fim da inbox.
    expect(timestampToIso(1_767_225_600)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts the same value as a string', () => {
    expect(timestampToIso('1767225600')).toBe('2026-01-01T00:00:00.000Z');
  });

  it.each([undefined, 0, -5, 'nonsense'])('falls back to now for %s', (raw) => {
    const now = () => Date.parse('2026-09-08T12:00:00.000Z');
    expect(timestampToIso(raw as never, now)).toBe('2026-09-08T12:00:00.000Z');
  });
});

describe('classifyEvolutionEvent', () => {
  it('reads a plain text message', () => {
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: JID, fromMe: false, id: 'EVO1' },
        pushName: 'Runyelle',
        message: { conversation: 'oi, tudo bem?' },
        messageTimestamp: 1_767_225_600,
      })
    );

    expect(result).toEqual({
      kind: 'message',
      message: {
        phone: '5583933455551',
        pushName: 'Runyelle',
        providerMessageId: 'EVO1',
        text: 'oi, tudo bem?',
        contentType: 'text',
        timestamp: '2026-01-01T00:00:00.000Z',
        instance: 'receptivo',
      },
    });
  });

  it('reads the extended text shape (message with a link preview)', () => {
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: JID, id: 'EVO2' },
        message: { extendedTextMessage: { text: 'olha isto: exemplo.com' } },
      })
    );
    expect(result).toMatchObject({
      kind: 'message',
      message: { text: 'olha isto: exemplo.com', contentType: 'text' },
    });
  });

  it('ignores our own outbound echo', () => {
    // Sem isto, cada resposta do atendente voltaria como se fosse do
    // cliente — e dispararia a auto-resposta da IA contra ela mesma.
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: JID, fromMe: true, id: 'EVO3' },
        message: { conversation: 'resposta do atendente' },
      })
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'outbound echo' });
  });

  it.each([
    ['1203630@g.us', 'group'],
    ['status@broadcast', 'status'],
  ])('ignores %s (%s)', (jid) => {
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: jid, fromMe: false, id: 'X' },
        message: { conversation: 'oi' },
      })
    );
    expect(result.kind).toBe('ignored');
  });

  it('maps media types and keeps the caption as the text', () => {
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: JID, id: 'EVO4' },
        message: { imageMessage: { caption: 'segue a foto' } },
      })
    );
    expect(result).toMatchObject({
      kind: 'message',
      message: { contentType: 'image', text: 'segue a foto' },
    });
  });

  it('keeps a media message that carries no caption', () => {
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: JID, id: 'EVO5' },
        message: { audioMessage: { seconds: 3 } },
      })
    );
    expect(result).toMatchObject({
      kind: 'message',
      message: { contentType: 'audio', text: null },
    });
  });

  it('ignores protocol noise with nothing renderable', () => {
    const result = classifyEvolutionEvent(
      upsert({
        key: { remoteJid: JID, id: 'EVO6' },
        message: { protocolMessage: { type: 'REVOKE' } },
      })
    );
    expect(result).toEqual({
      kind: 'ignored',
      reason: 'no renderable content',
    });
  });

  it('reads a connection update', () => {
    expect(
      classifyEvolutionEvent({
        event: 'connection.update',
        instance: 'receptivo',
        data: { state: 'open' },
      })
    ).toEqual({ kind: 'connection', state: 'open' });
  });

  it('accepts the UPPER_SNAKE event names the provider also emits', () => {
    expect(
      classifyEvolutionEvent({
        event: 'CONNECTION_UPDATE',
        data: { state: 'connecting' },
      })
    ).toEqual({ kind: 'connection', state: 'connecting' });
  });

  it('treats an unknown connection state as disconnected', () => {
    expect(
      classifyEvolutionEvent({
        event: 'connection.update',
        data: { state: 'something-new' },
      })
    ).toEqual({ kind: 'connection', state: 'close' });
  });

  it('ignores events we did not subscribe to', () => {
    expect(
      classifyEvolutionEvent({ event: 'contacts.update', data: {} }).kind
    ).toBe('ignored');
  });
});
