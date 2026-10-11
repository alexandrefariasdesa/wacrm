import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
  })),
}));

import { importEvolutionHistory } from './evolution-history';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import type { InboundEvolutionMessage } from './evolution-inbound';

type Row = { message_id: string; sender_type: string; created_at: string };

/** Banco falso: devolve `before` na leitura e `inserted` no upsert. */
function fakeDb(opts: {
  before: Record<string, unknown> | null;
  inserted: Row[];
}) {
  const updates: Record<string, unknown>[] = [];
  const upserts: unknown[][] = [];
  const db = {
    from(table: string) {
      if (table === 'messages') {
        return {
          upsert(rows: unknown[]) {
            upserts.push(rows);
            return { select: async () => ({ data: opts.inserted, error: null }) };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: opts.before }) }),
        }),
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { db: db as never, updates, upserts };
}

function msg(
  id: string,
  direction: 'inbound' | 'outbound',
  iso: string,
  text = 'x'
): InboundEvolutionMessage {
  return {
    phone: '5521996591535',
    pushName: direction === 'inbound' ? 'Maria' : 'Bivak Educacional',
    providerMessageId: id,
    text,
    contentType: 'text',
    timestamp: iso,
    instance: 'receptivo',
    direction,
  };
}

const CHANNEL = { id: 'ch-1', account_id: 'acc-1' };

beforeEach(() => vi.clearAllMocks());

describe('importEvolutionHistory', () => {
  it('counts only customer messages AFTER our last reply as unread', async () => {
    const batch = [
      msg('a', 'inbound', '2026-10-08T10:00:00.000Z'),
      msg('b', 'outbound', '2026-10-08T10:05:00.000Z'),
      msg('c', 'inbound', '2026-10-09T09:00:00.000Z'),
      msg('d', 'inbound', '2026-10-09T09:01:00.000Z'),
    ];
    const { db, updates } = fakeDb({
      before: { id: 'conv-1', status: 'open', unread_count: 0, last_message_at: null },
      inserted: batch.map((m) => ({
        message_id: m.providerMessageId!,
        sender_type: m.direction === 'inbound' ? 'customer' : 'agent',
        created_at: m.timestamp,
      })),
    });

    const r = await importEvolutionHistory(db, CHANNEL, batch);

    expect(r).toMatchObject({ received: 4, inserted: 4, conversations: 1, failed: 0 });
    expect(updates[0].unread_count).toBe(2);
    expect(updates[0].last_message_at).toBe('2026-10-09T09:01:00.000Z');
  });

  it('never moves a conversation backwards in time', async () => {
    const batch = [msg('old', 'inbound', '2026-10-01T10:00:00.000Z')];
    const { db, updates } = fakeDb({
      before: {
        id: 'conv-1',
        status: 'open',
        unread_count: 3,
        last_message_at: '2026-10-11T19:49:00.000Z',
      },
      inserted: [
        { message_id: 'old', sender_type: 'customer', created_at: batch[0].timestamp },
      ],
    });

    await importEvolutionHistory(db, CHANNEL, batch);

    expect(updates[0].last_message_at).toBeUndefined();
    expect(updates[0].last_message_text).toBeUndefined();
    // anterior ao que a conversa já tinha: não é "não lida"
    expect(updates[0].unread_count).toBeUndefined();
  });

  it('is a no-op for a replayed batch and skips ids-less messages', async () => {
    const noId = { ...msg('x', 'inbound', '2026-10-08T10:00:00.000Z'), providerMessageId: null };
    const { db, updates } = fakeDb({ before: null, inserted: [] });

    const r = await importEvolutionHistory(db, CHANNEL, [
      msg('a', 'inbound', '2026-10-08T10:00:00.000Z'),
      noId,
    ]);

    expect(r.received).toBe(1);
    expect(r.inserted).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('names the contact only from the customer side, never from our own pushName', async () => {
    const { db } = fakeDb({ before: null, inserted: [] });
    await importEvolutionHistory(db, CHANNEL, [
      msg('a', 'outbound', '2026-10-08T10:00:00.000Z'),
    ]);
    expect(vi.mocked(resolveConversationByPhone).mock.calls[0][3]).toBeNull();
  });
});
