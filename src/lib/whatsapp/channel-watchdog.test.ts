import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/channel-alert', () => ({
  notifyChannelEvent: vi.fn(async () => ({ telegram: false, email: true })),
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  evolutionCredentials: () => ({ baseUrl: 'http://evo', instance: 'r', apiKey: 'k' }),
}));
vi.mock('@/lib/whatsapp/providers/evolution', () => ({
  connectionState: vi.fn(),
}));
vi.mock('@/lib/whatsapp/channel-health', async (orig) => {
  const real = await orig<typeof import('./channel-health')>();
  return { ...real, applyChannelHealth: vi.fn() };
});

import { isBusinessHours, runChannelWatchdog } from './channel-watchdog';
import { applyChannelHealth } from '@/lib/whatsapp/channel-health';
import { notifyChannelEvent } from '@/lib/whatsapp/channel-alert';
import { connectionState } from '@/lib/whatsapp/providers/evolution';

const NOW = new Date('2026-10-12T16:00:00.000Z'); // 12:00 em Manaus

function fakeDb(
  channels: Record<string, unknown>[],
  lastInboundAt: string | null
) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({ not: async () => ({ data: channels, error: null }) }),
          }),
          update(patch: Record<string, unknown>) {
            updates.push(patch);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: lastInboundAt ? { created_at: lastInboundAt } : null,
                  }),
                }),
              }),
            }),
          }),
        }),
      };
    },
  };
  return { db: db as never, updates };
}

const channel = (over: Record<string, unknown> = {}) => ({
  id: 'ch-1',
  account_id: 'acc-1',
  kind: 'unofficial',
  label: 'Receptivo',
  provider_base_url: 'http://evo',
  provider_instance: 'r',
  health_state: 'up',
  health_changed_at: null,
  down_reminded_at: null,
  silence_alerted_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(applyChannelHealth).mockResolvedValue({
    kind: 'unchanged',
    followUp: null,
  });
});

describe('isBusinessHours', () => {
  it('is open at noon in Manaus and closed at night', () => {
    expect(isBusinessHours(new Date('2026-10-12T16:00:00Z'))).toBe(true);
    expect(isBusinessHours(new Date('2026-10-12T06:00:00Z'))).toBe(false); // 02h
    expect(isBusinessHours(new Date('2026-10-13T02:00:00Z'))).toBe(false); // 22h
  });
});

describe('runChannelWatchdog', () => {
  it('reports a closed session as down through the shared transition', async () => {
    vi.mocked(connectionState).mockResolvedValue('close');
    const { db } = fakeDb([channel()], null);

    await runChannelWatchdog(db, { now: NOW });

    expect(applyChannelHealth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'ch-1' }),
      'down',
      expect.any(String)
    );
  });

  it('treats an unreachable server as down', async () => {
    vi.mocked(connectionState).mockRejectedValue(new Error('timeout'));
    const { db } = fakeDb([channel()], null);

    const [item] = await runChannelWatchdog(db, { now: NOW });

    expect(item.observed).toBe('down');
  });

  it('does not invent an outage from a transient "connecting"', async () => {
    vi.mocked(connectionState).mockResolvedValue('connecting');
    const { db } = fakeDb([channel({ health_state: 'up' })], null);

    const [item] = await runChannelWatchdog(db, { now: NOW });

    expect(item.note).toBe('connecting');
    expect(applyChannelHealth).not.toHaveBeenCalled();
  });

  it('reminds once after 30 min down, then respects the 6 h interval', async () => {
    vi.mocked(connectionState).mockResolvedValue('close');
    const downSince = new Date(NOW.getTime() - 45 * 60_000).toISOString();
    const first = fakeDb(
      [channel({ health_state: 'down', health_changed_at: downSince })],
      null
    );
    const [a] = await runChannelWatchdog(first.db, { now: NOW });
    expect(a.reminder).toBe(true);
    expect(notifyChannelEvent).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    vi.mocked(applyChannelHealth).mockResolvedValue({ kind: 'unchanged', followUp: null });
    vi.mocked(connectionState).mockResolvedValue('close');
    const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const second = fakeDb(
      [
        channel({
          health_state: 'down',
          health_changed_at: downSince,
          down_reminded_at: recent,
        }),
      ],
      null
    );
    const [b] = await runChannelWatchdog(second.db, { now: NOW });
    expect(b.reminder).toBeUndefined();
    expect(notifyChannelEvent).not.toHaveBeenCalled();
  });

  it('flags a connected-but-deaf channel during business hours', async () => {
    vi.mocked(connectionState).mockResolvedValue('open');
    const lastIn = new Date(NOW.getTime() - 10 * 60 * 60_000).toISOString();
    const { db } = fakeDb([channel()], lastIn);

    const [item] = await runChannelWatchdog(db, { now: NOW, silenceHours: 8 });

    expect(item.silence).toBe(true);
    expect(notifyChannelEvent).toHaveBeenCalledTimes(1);
  });

  it('does not flag silence at night or when a customer wrote recently', async () => {
    vi.mocked(connectionState).mockResolvedValue('open');
    const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString();

    const day = fakeDb([channel()], recent);
    const [a] = await runChannelWatchdog(day.db, { now: NOW, silenceHours: 8 });
    expect(a.silence).toBeUndefined();

    const night = new Date('2026-10-12T06:00:00.000Z'); // 02h em Manaus
    const old = new Date(night.getTime() - 20 * 60 * 60_000).toISOString();
    const quiet = fakeDb([channel()], old);
    const [b] = await runChannelWatchdog(quiet.db, { now: night, silenceHours: 8 });
    expect(b.silence).toBeUndefined();
    expect(notifyChannelEvent).not.toHaveBeenCalled();
  });
});
