// The landing page ports onto risk (B1-11g): landingQuota reserves the IP slot atomically through
// risk.admitIp and hands back its release; afterAccepted does not count the IP again for a landing
// send. The reservation script itself runs against a stub namespace here (its Lua runs against a
// real Redis in the rule tests, test/spec/identity/landing-sms).
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type RedisHandle } from '../../platform/index.ts';
import { createSmsRisk, ephemeralSmsRiskIndex, type SmsRisk } from '../../risk/index.ts';
import { createSmsRiskPorts } from './sms-risk-ports.ts';
import type { LandingSlot, SmsRequest } from './sms-codes.ts';

const IP = '203.0.113.7';

function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

function ports(risk: Partial<SmsRisk>) {
  const { logger, lines } = memoryLogger();
  const full: SmsRisk = {
    admit: vi.fn(async () => ({ code: 0 as const })),
    admitIp: vi.fn(async () => ({ code: 0 as const, reservation: 'r1' })),
    releaseIp: vi.fn(async () => undefined),
    recordAccepted: vi.fn(async () => undefined),
    recordRegistered: vi.fn(async () => undefined),
    ...risk,
  };
  const created = createSmsRiskPorts({
    risk: full,
    logger,
    devices: { deviceHashOf: async () => 'ab'.repeat(32) },
  });
  return { ...created, risk: full, lines };
}

const landing: SmsRequest = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login',
  client_ip: IP,
  channel: 'landing',
};

it('[AC-B1-11g#11] landingQuota reserves through admitIp and its release drops that reservation', async () => {
  const p = ports({});
  const verdict = await p.smsHooks.landingQuota(landing);
  expect(verdict.code).toBe(0);
  expect(p.risk.admitIp).toHaveBeenCalledExactlyOnceWith({ appId: 'couli', clientIp: IP });
  expect(p.risk.admit).not.toHaveBeenCalled();
  expect(p.risk.releaseIp).not.toHaveBeenCalled();
  await (verdict as LandingSlot).release();
  expect(p.risk.releaseIp).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli',
    clientIp: IP,
    reservation: 'r1',
  });
});

it('[AC-B1-11g#8] landingQuota passes admitIp 42901 through; no IP or no admitIp refuses', async () => {
  const limited = ports({
    admitIp: vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 601 })),
  });
  expect(await limited.smsHooks.landingQuota(landing)).toEqual({ code: 42901, retryAfterSec: 601 });
  const { client_ip: clientIp, ...withoutIp } = landing;
  void clientIp;
  const p = ports({});
  expect(await p.smsHooks.landingQuota(withoutIp)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(p.risk.admitIp).not.toHaveBeenCalled();
  const { logger } = memoryLogger();
  const old = createSmsRiskPorts({
    risk: {
      admit: async () => ({ code: 0 }),
      recordAccepted: async () => undefined,
      recordRegistered: async () => undefined,
    },
    logger,
    devices: { deviceHashOf: async () => null },
  });
  expect(await old.smsHooks.landingQuota(landing)).toEqual({ code: 42901, retryAfterSec: 1 });
});

it('[AC-B1-11g#19] afterAccepted counts only the budget for a landing send, the IP too for the app route', async () => {
  const p = ports({});
  await p.smsHooks.afterAccepted(landing);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli' });
  await p.smsHooks.afterAccepted({ ...landing, channel: 'app', device_id: 'd1' });
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli', clientIp: IP });
});

/** A namespace stub that answers the reservation script and records each call. */
function scriptRedis(answer: (keys: readonly string[]) => unknown, calls: unknown[][]) {
  const fail = () => Promise.reject(new Error('unused'));
  return {
    namespace: () => ({
      get: fail,
      set: fail,
      eval: (script: string, options: { keys: readonly string[]; args: readonly string[] }) => {
        calls.push([
          script.includes('ZREM') && !script.includes('ZADD') ? 'release' : 'reserve',
          [...options.keys],
          [...options.args],
        ]);
        return Promise.resolve(answer(options.keys));
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
}

function risk(redis: RedisHandle | null) {
  const { logger, lines } = memoryLogger();
  return {
    lines,
    risk: createSmsRisk({
      clock: new FixedClock('2026-10-18T10:00:00+08:00'),
      redis,
      logger,
      config: { configValue: () => Promise.resolve(null) },
      crypto: ephemeralSmsRiskIndex(),
    }),
  };
}

it('[AC-B1-11g#11] admitIp reserves in one script over both IP keys and releases the same member', async () => {
  const calls: unknown[][] = [];
  const r = risk(scriptRedis((keys) => (keys.length === 2 ? [0, 0] : 1), calls)).risk;
  const admission = await r.admitIp({ appId: 'couli', clientIp: IP });
  expect(admission).toMatchObject({ code: 0, reservation: expect.any(String) });
  expect(calls).toHaveLength(1);
  const [kind, keys, args] = calls[0] as [string, string[], string[]];
  expect(kind).toBe('reserve');
  expect(keys.map((key) => key.split(':')[0])).toEqual(['ip_send', 'ip_reg']);
  expect(JSON.stringify(keys)).not.toContain(IP);
  const reservation = (admission as { reservation: string }).reservation;
  expect(args.at(-1)).toBe(reservation);
  expect(args.slice(1, 4)).toEqual(['3600000', '20', '5']);
  await r.releaseIp({ appId: 'couli', clientIp: IP, reservation });
  expect(calls[1]).toEqual(['release', [keys[0]], [reservation]]);
});

it('[AC-B1-11g#10] admitIp answers 42901 with the later IP release; no store or a failure refuses', async () => {
  const calls: unknown[][] = [];
  expect(
    await risk(scriptRedis(() => [15_200, 6_000], calls)).risk.admitIp({
      appId: 'couli',
      clientIp: IP,
    }),
  ).toEqual({ code: 42901, retryAfterSec: 16 });
  expect(await risk(null).risk.admitIp({ appId: 'couli', clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  const failing = {
    namespace: () => ({
      get: () => Promise.reject(new Error('unused')),
      set: () => Promise.reject(new Error('unused')),
      eval: () => Promise.reject(Object.assign(new Error(`down ${IP}`), { reason: 'x' })),
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
  const down = risk(failing);
  expect(await down.risk.admitIp({ appId: 'couli', clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  expect(down.lines.join('')).not.toContain(IP);
});
