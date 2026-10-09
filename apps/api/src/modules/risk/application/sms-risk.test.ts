import { describe, expect, it } from 'vitest';
import { FixedClock, createRootLogger, type RedisHandle } from '../../platform/index.ts';
import { createSmsRisk, ephemeralSmsRiskIndex, smsBudgetDay } from './sms-risk.ts';

function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

function failingRedis(): RedisHandle {
  const fail = () => Promise.reject(Object.assign(new Error('down 192.0.2.1'), { reason: 'x' }));
  return {
    namespace: () => ({ get: fail, set: fail, eval: fail }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  };
}

/** Records the keys of every script call; answers like an empty store (admit, no alert). */
function recordingRedis(calls: string[][]): RedisHandle {
  const answer = (keys: readonly string[]): unknown =>
    keys.length === 3 ? [1, 0, 0] : keys[0]!.startsWith('dev:') ? [1, 0] : [0, 0];
  const evalScript = (_script: string, options: { keys: readonly string[] }) => {
    calls.push([...options.keys]);
    return Promise.resolve(answer(options.keys));
  };
  const fail = () => Promise.reject(new Error('unused'));
  return {
    namespace: () => ({ get: fail, set: fail, eval: evalScript }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
}

const request = {
  appId: 'unit_app',
  deviceHash: 'ab'.repeat(32),
  phone: '13812345678',
  clientIp: '192.0.2.1',
};

describe('sms risk', () => {
  it('[AC-B1-03g#10] budget day follows the +08:00 natural day', () => {
    expect(smsBudgetDay(Date.parse('2031-05-06T15:59:59.999Z'))).toBe('2031-05-06');
    expect(smsBudgetDay(Date.parse('2031-05-06T16:00:00Z'))).toBe('2031-05-07');
    expect(smsBudgetDay(Date.parse('2024-02-28T16:00:00Z'))).toBe('2024-02-29');
    expect(smsBudgetDay(Date.parse('2030-12-31T16:00:00Z'))).toBe('2031-01-01');
  });

  it('[AC-B1-03g#9] no Redis refuses with Retry-After 1; one error log per outage', async () => {
    const { logger, lines } = memoryLogger();
    const risk = createSmsRisk({
      clock: new FixedClock('2031-05-06T09:00:00Z'),
      redis: null,
      logger,
      config: { configValue: () => Promise.resolve(null) },
      crypto: ephemeralSmsRiskIndex(),
    });
    expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1 });
    expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1 });
    await risk.recordAccepted(request);
    await risk.recordRegistered({ ...request, userId: 'u' });
    expect(lines.filter((line) => line.includes('sms_risk_store_unavailable'))).toHaveLength(1);
  });

  it('[AC-B1-03g#9] a failing store refuses and logs neither phone nor IP', async () => {
    const { logger, lines } = memoryLogger();
    const risk = createSmsRisk({
      clock: new FixedClock('2031-05-06T09:00:00Z'),
      redis: failingRedis(),
      logger,
      config: { configValue: () => Promise.reject(new Error('offline')) },
      crypto: ephemeralSmsRiskIndex(),
    });
    expect(await risk.admit(request)).toEqual({ code: 42901, retryAfterSec: 1 });
    await risk.recordAccepted(request);
    const text = lines.join('');
    expect(text).not.toContain(request.phone);
    expect(text).not.toContain(request.clientIp);
    expect(lines.filter((line) => line.includes('"level":50'))).toHaveLength(1);
  });

  it('[AC-B1-03g#2] a send with no client IP skips only the IP items; the device is still judged', async () => {
    const { logger } = memoryLogger();
    const calls: string[][] = [];
    const risk = createSmsRisk({
      clock: new FixedClock('2031-05-06T09:00:00Z'),
      redis: recordingRedis(calls),
      logger,
      config: { configValue: () => Promise.resolve(null) },
      crypto: ephemeralSmsRiskIndex(),
    });
    const withoutIp = {
      appId: request.appId,
      deviceHash: request.deviceHash,
      phone: request.phone,
    };
    expect(await risk.admit(withoutIp)).toEqual({ code: 0 });
    expect(calls.map((keys) => keys[0]!.split(':')[0])).toEqual(['dev']);
    calls.length = 0;
    await risk.recordAccepted({ appId: request.appId });
    expect(calls.map((keys) => keys[0]!.split(':')[0])).toEqual(['budget']);
    calls.length = 0;
    expect(await risk.admit(request)).toEqual({ code: 0 });
    expect(calls.map((keys) => keys[0]!.split(':')[0])).toEqual(['ip_send', 'dev']);
  });
});
