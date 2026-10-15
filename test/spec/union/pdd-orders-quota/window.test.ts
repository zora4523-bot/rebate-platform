import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { ctx, incrementReply, setup } from '../pdd-orders/kit.ts';

const dayMs = 86_400_000;
const nowMs = Date.parse('2026-10-15T00:00:00.500Z');
const oldestMs = nowMs - 90 * dayMs;

it.each([
  ['完整 24 小时', nowMs - dayMs, nowMs],
  ['不足 24 小时但外扩成 86401 秒', nowMs - dayMs + 100, nowMs - 100],
  ['恰好 90 天且完整 24 小时', oldestMs, oldestMs + dayMs],
  ['90 天界内一毫秒', oldestMs + 1, oldestMs + 60_000],
] as const)(
  '[AC-B1-04w-WIN#1] %s 按毫秒接受，发给上游的整秒边界仍受双限约束',
  async (_name, fromMs, toMs) => {
    const { adapter, clock, requests } = setup(incrementReply([]));
    clock.advanceMs(500);
    const window = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    const outcome = await adapter.listOrders(window, {}, ctx).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        code: error instanceof UnionError ? error.code : String(error),
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.value).toEqual({ items: [], nextCursor: null });
    expect(requests).toHaveLength(1);
    const start = requests[0]!.start_update_time as number;
    const end = requests[0]!.end_update_time as number;
    expect(Number.isInteger(start)).toBe(true);
    expect(Number.isInteger(end)).toBe(true);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThanOrEqual(86_400);
    expect(start * 1000).toBeGreaterThanOrEqual(oldestMs);
    // No arbitrary truncation: only the subsecond rounding may be pulled back to the limits.
    expect(start).toBeGreaterThanOrEqual(Math.floor(fromMs / 1000));
    expect(start).toBeLessThanOrEqual(Math.ceil(fromMs / 1000));
    expect(end).toBeGreaterThanOrEqual(Math.floor(toMs / 1000));
    expect(end).toBeLessThanOrEqual(Math.ceil(toMs / 1000));

    // Ordinary windows still round outward, rather than globally rounding inward to pass limits.
    const ordinary = { from: '2026-10-14T01:00:00.123Z', to: '2026-10-14T01:01:00.456Z' };
    await expect(adapter.listOrders(ordinary, {}, ctx)).resolves.toHaveProperty('items');
    expect(requests[1]).toMatchObject({
      start_update_time: Date.parse('2026-10-14T01:00:00Z') / 1000,
      end_update_time: Date.parse('2026-10-14T01:01:01Z') / 1000,
    });

    for (const invalid of [
      { from: new Date(nowMs - dayMs - 1).toISOString(), to: new Date(nowMs).toISOString() },
      { from: new Date(oldestMs - 1).toISOString(), to: new Date(oldestMs + 60_000).toISOString() },
    ]) {
      await expect(adapter.listOrders(invalid, {}, ctx)).rejects.toMatchObject({
        code: 'invalid_dto',
      });
    }
    expect(requests).toHaveLength(2);
  },
);

it.each([
  ['相等', '2026-10-14T01:00:00.500Z', '2026-10-14T01:00:00.500Z'],
  ['同秒内逆序', '2026-10-14T01:00:00.501Z', '2026-10-14T01:00:00.500Z'],
] as const)(
  '[AC-B1-04w-WIN#2] %s 不能被向外取整变成合法窗口，在凭据与传输前拒绝',
  async (_name, from, to) => {
    const { adapter, credentials, transport } = setup(incrementReply([]));
    await expect(adapter.listOrders({ from, to }, {}, ctx)).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'pdd',
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    // Adjacent millisecond instants in the same second are ordered and must remain usable.
    await expect(
      adapter.listOrders(
        {
          from: '2026-10-14T01:00:00.500Z',
          to: '2026-10-14T01:00:00.501Z',
        },
        {},
        ctx,
      ),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(transport).toHaveBeenCalledTimes(1);
  },
);
