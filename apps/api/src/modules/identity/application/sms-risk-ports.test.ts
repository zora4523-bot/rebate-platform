// The ports onto risk's IP reservation (B1-11g): landingQuota (admitIp) and the app route's
// deviceQuota (admitAndReserve) reserve the IP send atomically and hand back its release;
// afterAccepted's recordAccepted settles the reservation (no second count). The scripts run
// against a stub namespace here (their Lua runs against a real Redis in the rule tests,
// test/spec/identity/landing-sms and test/spec/risk/sms-risk).
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type RedisHandle } from '../../platform/index.ts';
import { createSmsRisk, ephemeralSmsRiskIndex, type SmsRisk } from '../../risk/index.ts';
import { createSmsRiskPorts } from './sms-risk-ports.ts';
import type { SmsIpSlot, SmsRequest } from './sms-codes.ts';

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
    admitAndReserve: vi.fn(async () => ({ code: 0 as const, reservation: 'r2' })),
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
  await (verdict as SmsIpSlot).release();
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

const app: SmsRequest = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login',
  client_ip: IP,
  device_id: 'd1',
};

it('[AC-B1-11g#13] the app route reserves through admitAndReserve and its slot releases that reservation', async () => {
  const p = ports({});
  const verdict = await p.smsHooks.deviceQuota(app);
  expect(p.risk.admitAndReserve).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli',
    deviceHash: 'ab'.repeat(32),
    phone: app.phone,
    clientIp: IP,
  });
  expect(p.risk.admit).not.toHaveBeenCalled();
  expect(verdict).toMatchObject({ code: 0 });
  await (verdict as SmsIpSlot).release();
  expect(p.risk.releaseIp).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli',
    clientIp: IP,
    reservation: 'r2',
  });
});

it('[AC-B1-11g#13] the app route passes 42901 through; nothing reserved (no IP) is null; no reserving port falls back to admit', async () => {
  const limited = ports({
    admitAndReserve: vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 17 })),
  });
  expect(await limited.smsHooks.deviceQuota(app)).toEqual({ code: 42901, retryAfterSec: 17 });
  const bare = ports({ admitAndReserve: vi.fn(async () => ({ code: 0 as const })) });
  expect(await bare.smsHooks.deviceQuota(app)).toBeNull();
  const { logger } = memoryLogger();
  const admit = vi.fn(async () => ({ code: 0 as const }));
  const old = createSmsRiskPorts({
    risk: { admit, recordAccepted: async () => undefined, recordRegistered: async () => undefined },
    logger,
    devices: { deviceHashOf: async () => 'cd'.repeat(32) },
  });
  expect(await old.smsHooks.deviceQuota(app)).toBeNull();
  expect(admit).toHaveBeenCalledOnce();
});

it('[AC-B1-11g#19] afterAccepted hands the client IP to recordAccepted (which settles the reservation)', async () => {
  const p = ports({});
  await p.smsHooks.afterAccepted(landing);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli', clientIp: IP });
  await p.smsHooks.afterAccepted(app);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli', clientIp: IP });
});

interface ScriptCall {
  readonly keys: string[];
  readonly args: string[];
  readonly script: string;
}

/** A namespace stub that answers each script through `answer` and records each call. */
function scriptRedis(answer: (call: ScriptCall) => unknown, calls: ScriptCall[]) {
  const fail = () => Promise.reject(new Error('unused'));
  return {
    namespace: () => ({
      get: fail,
      set: fail,
      eval: (script: string, options: { keys: readonly string[]; args: readonly string[] }) => {
        const call = { keys: [...options.keys], args: [...options.args], script };
        calls.push(call);
        return Promise.resolve(answer(call));
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
}

const prefixes = (call: ScriptCall | undefined) => call?.keys.map((key) => key.split(':')[0]);

/** Answers like an empty store: reserve / IP read {0, 0}, device admitted, budget no alert. */
function emptyStore(call: ScriptCall): unknown {
  const first = prefixes(call)![0];
  if (first === 'dev') return [1, 0];
  if (first === 'budget') return [1, 0, 0];
  if (call.keys.length >= 2 && first === 'ip_send' && call.script.includes('wait(')) return [0, 0];
  return 1;
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

it('[AC-B1-11g#11] admitIp reserves over the send, registration and in-flight keys; release names the reservation', async () => {
  const calls: ScriptCall[] = [];
  const r = risk(scriptRedis(emptyStore, calls)).risk;
  const admission = await r.admitIp({ appId: 'couli', clientIp: IP });
  expect(admission).toMatchObject({ code: 0, reservation: expect.any(String) });
  expect(calls).toHaveLength(1);
  expect(prefixes(calls[0])).toEqual(['ip_send', 'ip_reg', 'ip_pend']);
  expect(calls[0]!.script).toContain("'p:' .. ARGV[6]");
  expect(JSON.stringify(calls[0]!.keys)).not.toContain(IP);
  const reservation = (admission as { reservation: string }).reservation;
  expect(calls[0]!.args.slice(1)).toEqual(['3600000', '20', '5', reservation]);
  await r.releaseIp({ appId: 'couli', clientIp: IP, reservation });
  expect(prefixes(calls[1])).toEqual(['ip_send', 'ip_pend']);
  // A normal release may drop another in-flight record when an acceptance settled its own.
  expect(calls[1]!.args).toEqual([reservation, '0']);
});

it('[AC-B1-11g#13] admitAndReserve reserves the IP, then judges the device; a device refusal releases the IP', async () => {
  const calls: ScriptCall[] = [];
  const r = risk(scriptRedis(emptyStore, calls)).risk;
  const request = { appId: 'couli', deviceHash: 'ab'.repeat(32), phone: '13912345678' };
  const admitted = await r.admitAndReserve({ ...request, clientIp: IP });
  expect(admitted).toMatchObject({ code: 0, reservation: expect.any(String) });
  expect(calls.map(prefixes)).toEqual([
    ['ip_send', 'ip_reg', 'ip_pend'],
    ['dev', 'req'],
  ]);
  calls.length = 0;
  expect(await r.admitAndReserve(request)).toEqual({ code: 0 });
  expect(calls.map(prefixes)).toEqual([['dev', 'req']]);

  const refusing: ScriptCall[] = [];
  const full = risk(
    scriptRedis((call) => (prefixes(call)![0] === 'dev' ? [0, 5_000] : emptyStore(call)), refusing),
  ).risk;
  expect(await full.admitAndReserve({ ...request, clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 5,
  });
  const reservation = refusing[0]!.args.at(-1);
  expect(refusing.map(prefixes)).toEqual([
    ['ip_send', 'ip_reg', 'ip_pend'],
    ['dev', 'req'],
    ['ip_send', 'ip_pend'],
  ]);
  expect(refusing[2]!.args).toEqual([reservation, '0']);
});

it('[AC-B1-11g#19] recordAccepted with a client IP settles an in-flight record at now (one script), without one only the budget', async () => {
  const calls: ScriptCall[] = [];
  const r = risk(scriptRedis(emptyStore, calls)).risk;
  await r.recordAccepted({ appId: 'couli', clientIp: IP });
  expect(calls.map(prefixes)).toEqual([
    ['ip_send', 'ip_pend'],
    ['budget', 'budget', 'budget'],
  ]);
  expect(calls[0]!.script).toContain("redis.call('ZRANGE', KEYS[2], 0, 0)");
  expect(calls[0]!.args[0]).toBe(String(Date.parse('2026-10-18T10:00:00+08:00')));
  calls.length = 0;
  await r.recordAccepted({ appId: 'couli' });
  expect(calls.map(prefixes)).toEqual([['budget', 'budget', 'budget']]);
});

it('[AC-B1-11g#10] admitIp answers 42901 with the later IP release; no store or a failure refuses and drops only its own record', async () => {
  const calls: ScriptCall[] = [];
  expect(
    await risk(scriptRedis(() => [15_200, 6_000], calls)).risk.admitIp({
      appId: 'couli',
      clientIp: IP,
    }),
  ).toEqual({ code: 42901, retryAfterSec: 16 });
  expect(calls).toHaveLength(1);
  expect(await risk(null).risk.admitIp({ appId: 'couli', clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  const seen: ScriptCall[] = [];
  const failing = {
    namespace: () => ({
      get: () => Promise.reject(new Error('unused')),
      set: () => Promise.reject(new Error('unused')),
      eval: (script: string, options: { keys: readonly string[]; args: readonly string[] }) => {
        seen.push({ keys: [...options.keys], args: [...options.args], script });
        return Promise.reject(Object.assign(new Error(`down ${IP}`), { reason: 'x' }));
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
  const down = risk(failing);
  expect(await down.risk.admitIp({ appId: 'couli', clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  // The lost reply's release is strict: it never drops another send's in-flight record.
  expect(seen.map(prefixes)).toEqual([
    ['ip_send', 'ip_reg', 'ip_pend'],
    ['ip_send', 'ip_pend'],
  ]);
  expect(seen[1]!.args).toEqual([seen[0]!.args.at(-1), '1']);
  expect(down.lines.join('')).not.toContain(IP);
});
