import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/channel-alert', () => ({
  notifyChannelEvent: vi.fn(async () => ({ telegram: false, email: true })),
}));
vi.mock('@/lib/whatsapp/providers/evolution-reconcile', () => ({
  reconcileEvolutionChannel: vi.fn(async () => ({
    inserted: 3,
    since: '2026-10-11T10:00:00.000Z',
    fetched: 3,
    received: 3,
    conversations: 1,
    failed: 0,
  })),
}));

import { applyChannelHealth, humanDuration } from './channel-health';
import { notifyChannelEvent } from '@/lib/whatsapp/channel-alert';
import { reconcileEvolutionChannel } from '@/lib/whatsapp/providers/evolution-reconcile';

/** Banco falso: o update condicional "ganha" ou "perde" a corrida. */
function fakeDb(win: boolean) {
  const patches: Record<string, unknown>[] = [];
  const guards: [string, unknown][] = [];
  const db = {
    from: () => ({
      update(patch: Record<string, unknown>) {
        patches.push(patch);
        const chain = {
          eq(col: string, val: unknown) {
            guards.push([col, val]);
            return chain;
          },
          select: async () => ({ data: win ? [{ id: 'ch-1' }] : [], error: null }),
        };
        return chain;
      },
    }),
  };
  return { db: db as never, patches, guards };
}

const base = {
  id: 'ch-1',
  account_id: 'acc-1',
  label: 'Receptivo',
  display_number: '+55 54 8132-4407',
  kind: 'unofficial',
} as never;

function channel(health_state: string, health_changed_at: string | null = null) {
  return { ...(base as object), health_state, health_changed_at } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('applyChannelHealth', () => {
  it('does nothing when the observed state is the one already recorded', async () => {
    const { db, patches } = fakeDb(true);
    const t = await applyChannelHealth(db, channel('up'), 'up');
    expect(t).toEqual({ kind: 'unchanged', followUp: null });
    expect(patches).toHaveLength(0);
  });

  it('flags up → down and alerts through the follow-up', async () => {
    const { db, patches, guards } = fakeDb(true);
    const t = await applyChannelHealth(db, channel('up'), 'down', 'sessão encerrada');

    expect(t.kind).toBe('went_down');
    expect(patches[0]).toMatchObject({ health_state: 'down', status: 'disconnected' });
    // a trava de corrida compara com o estado ANTIGO
    expect(guards).toContainEqual(['health_state', 'up']);

    await t.followUp!();
    expect(notifyChannelEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyChannelEvent).mock.calls[0][0]).toContain('DESCONECTADO');
    expect(reconcileEvolutionChannel).not.toHaveBeenCalled();
  });

  it('does not alert when another caller already won the same transition', async () => {
    const { db } = fakeDb(false);
    const t = await applyChannelHealth(db, channel('up'), 'down');
    expect(t).toEqual({ kind: 'unchanged', followUp: null });
    expect(notifyChannelEvent).not.toHaveBeenCalled();
  });

  it('reconciles and reports how long it was down on down → up', async () => {
    const { db, patches } = fakeDb(true);
    const downSince = new Date(Date.now() - 90 * 60_000).toISOString();
    const t = await applyChannelHealth(db, channel('down', downSince), 'up');

    expect(t.kind).toBe('came_back');
    expect(patches[0]).toMatchObject({ health_state: 'up', status: 'connected' });

    await t.followUp!();
    expect(reconcileEvolutionChannel).toHaveBeenCalledTimes(1);
    const [subject, body] = vi.mocked(notifyChannelEvent).mock.calls[0];
    expect(subject).toContain('VOLTOU');
    expect(body).toContain('1 h 30 min');
    expect(body).toContain('3 mensagem');
  });

  it('stays quiet on the very first reading of a healthy channel', async () => {
    const { db } = fakeDb(true);
    const t = await applyChannelHealth(db, channel('unknown'), 'up');
    expect(t).toEqual({ kind: 'first_seen', followUp: null });
  });

  it('alerts when the very first reading is already down', async () => {
    const { db } = fakeDb(true);
    const t = await applyChannelHealth(db, channel('unknown'), 'down');
    expect(t.kind).toBe('went_down');
  });
});

describe('humanDuration', () => {
  it.each([
    [30_000, '1 min'],
    [45 * 60_000, '45 min'],
    [150 * 60_000, '2 h 30 min'],
    [4 * 24 * 60 * 60_000, '4 dias'],
  ])('%i ms → %s', (ms, expected) => {
    expect(humanDuration(ms)).toBe(expected);
  });
});
