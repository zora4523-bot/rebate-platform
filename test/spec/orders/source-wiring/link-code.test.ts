import { afterEach, expect, it, vi } from 'vitest';
import { createOrderSourcePorts } from '../../../../apps/api/src/modules/orders/application/source-ports.ts';
import { built, capture } from '../../linking/link-code/kit.ts';
import { wired } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[AC-B1-08s#25] 来源装配原样透传 linkByCode 入参、他人的行、null 与异常，构造零调用', async () => {
  const link = {
    link_id: 'synthetic-link',
    user_id: 'another-user',
    scene: 'agent',
    agent_session_id: 'session',
  };
  const linkByCode = vi.fn(async () => link as typeof link | null);
  const reads = {
    linkByCode,
    linkLogs: vi.fn(async () => []),
    keyPrefix: vi.fn(async () => 'pdd'),
    configValue: vi.fn(async () => null),
  };
  const ports = await built(() => createOrderSourcePorts(reads));
  expect(typeof ports.linkByCode).toBe('function');
  for (const port of Object.values(reads)) expect(port).not.toHaveBeenCalled();
  const input = { appId: 'app-a', platform: 'pdd' as const, lk: 'a1b2c3' };
  expect(await built(() => ports.linkByCode!(input))).toBe(link);
  expect(linkByCode).toHaveBeenLastCalledWith(input);
  linkByCode.mockResolvedValueOnce(null);
  expect(await built(() => ports.linkByCode!(input))).toBeNull();
  const fault = new Error('synthetic read failure');
  linkByCode.mockRejectedValueOnce(fault);
  expect(await capture(() => ports.linkByCode!(input))).toEqual({ ok: false, error: fault });
});

it('[AC-B1-08s#26] 真实 worker 注入 linkByCode、装配零查询；DummyDriver 的合法 1～16 位返回 null', async () => {
  vi.useFakeTimers();
  const f = await built(() => wired());
  try {
    expect(typeof f.sources.linkByCode).toBe('function');
    expect(f.updateDeps.sources).toBe(f.deps.sources);
    expect(f.queries).toEqual([]);
    for (const lk of ['a1b2c3', '0', 'z'.repeat(16)]) {
      expect(
        await built(() => f.sources.linkByCode!({ appId: 'n', platform: 'pdd', lk })),
      ).toBeNull();
    }
    expect(f.queries).toHaveLength(3);
    expect(f.queue.send).not.toHaveBeenCalled();
  } finally {
    await f.context.close();
  }
});
