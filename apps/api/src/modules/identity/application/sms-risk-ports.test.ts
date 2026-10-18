// The ports onto risk's IP reservation (B1-11g): landingQuota (admitIp) and the app route's
// deviceQuota (admitAndReserve) reserve the IP send atomically and hand back a slot carrying the
// reservation; release names exactly that reservation, and afterAccepted hands it to
// recordAccepted so that exactly that in-flight record becomes the send's record. The Lua scripts themselves run against a real Redis only in the rule tests
// (test/spec/identity/landing-sms, test/spec/risk/sms-risk); here an in-memory model of the same
// sets (dispatched on each script's `-- sms_risk:<name>` label) checks which records each step
// touches, including lost replies and failures (never an under-count).
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
  expect((verdict as SmsIpSlot).reservation).toBe('r2');
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

it("[AC-B1-11g#19] afterAccepted hands recordAccepted the send's reservation; without a slot the two-argument call", async () => {
  const p = ports({});
  const slot = { code: 0 as const, reservation: 'r9', release: async () => undefined };
  await p.smsHooks.afterAccepted(landing, slot);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({
    appId: 'couli',
    clientIp: IP,
    reservation: 'r9',
  });
  await p.smsHooks.afterAccepted(app);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli', clientIp: IP });
  await p.smsHooks.afterAccepted(app, null);
  expect(p.risk.recordAccepted).toHaveBeenLastCalledWith({ appId: 'couli', clientIp: IP });
});

/** In-memory model of the IP sets and the other risk keys, one method per script label. */
function modelRedis(clock: FixedClock) {
  const zsets = new Map<string, Map<string, number>>();
  const calls: { label: string; keys: string[] }[] = [];
  /** Labels whose next call runs and then loses its reply; `during` runs before the throw. */
  const lost = new Map<string, () => Promise<void>>();
  /** Labels whose next calls fail before they run (one entry per failing call). */
  const failing: string[] = [];
  const set = (key: string) => {
    let found = zsets.get(key);
    if (found === undefined) zsets.set(key, (found = new Map()));
    return found;
  };
  const dropBefore = (key: string, low: number) => {
    for (const [member, score] of set(key)) if (score < low) set(key).delete(member);
  };
  const wait = (key: string, limit: number, now: number, window: number) => {
    const live = [...set(key).values()]
      .filter((score) => score >= now - window && score <= now)
      .sort((x, y) => x - y);
    if (live.length < limit) return 0;
    return Math.max(1, live[live.length - limit]! + window + 1000 - now);
  };
  function run(label: string, keys: string[], argv: string[]): unknown {
    const num = (i: number) => Number(argv[i - 1]);
    switch (label) {
      case 'ip_reserve': {
        const [send, reg, pend] = keys as [string, string, string];
        const now = num(2);
        const waits = [wait(send, num(4), now, num(3)), wait(reg, num(5), now, num(3))];
        if (waits[0]! > 0 || waits[1]! > 0) return waits;
        dropBefore(send, now - num(3));
        dropBefore(pend, now - num(3));
        set(send).set(`p:${argv[5]}`, now);
        set(pend).set(argv[5]!, now);
        return [0, 0];
      }
      case 'ip_release': {
        const [send, pend] = keys as [string, string];
        if (set(pend).delete(argv[1]!)) set(send).delete(`p:${argv[1]}`);
        return 1;
      }
      case 'ip_accept': {
        const [send, pend] = keys as [string, string];
        const now = num(2);
        dropBefore(send, now - num(3));
        dropBefore(pend, now - num(3));
        const own = argv[4]!;
        if (own !== '') {
          if (set(pend).delete(own)) set(send).delete(`p:${own}`);
        } else {
          const oldest = [...set(pend)].sort((x, y) => x[1] - y[1])[0];
          if (oldest !== undefined) {
            set(pend).delete(oldest[0]);
            set(send).delete(`p:${oldest[0]}`);
          }
        }
        set(send).set(argv[3]!, now);
        return 1;
      }
      case 'dev':
        return [1, 0];
      case 'budget':
        return [1, 0, 0];
      default:
        throw new Error(`unmodelled script ${label}`);
    }
  }
  const redis = {
    namespace: () => ({
      get: () => Promise.reject(new Error('unused')),
      set: () => Promise.reject(new Error('unused')),
      eval: async (
        script: string,
        options: { keys: readonly string[]; args: readonly string[]; ttlSeconds: number },
      ) => {
        const label = /^-- sms_risk:([a-z_]+)/.exec(script)?.[1] ?? options.keys[0]!.split(':')[0]!;
        calls.push({ label, keys: [...options.keys] });
        const failure = failing.indexOf(label);
        if (failure >= 0) {
          failing.splice(failure, 1);
          throw Object.assign(new Error('unavailable'), { reason: 'command_failed' });
        }
        const reply = run(label, [...options.keys], [String(options.ttlSeconds), ...options.args]);
        const during = lost.get(label);
        if (during !== undefined) {
          lost.delete(label);
          await during();
          throw Object.assign(new Error('reply lost'), { reason: 'command_timeout' });
        }
        return reply;
      },
    }),
    close: () => Promise.resolve(),
    onApplicationShutdown: () => Promise.resolve(),
  } as unknown as RedisHandle;
  /** Records in the IP's send set inside the window at the clock's now. */
  const sendCount = () => {
    const now = clock.now().getTime();
    const key = [...zsets.keys()].find((k) => k.startsWith('ip_send:'));
    return key === undefined
      ? 0
      : [...set(key).values()].filter((t) => t >= now - 3_600_000 && t <= now).length;
  };
  const pending = () =>
    [...zsets.entries()]
      .filter(([key]) => key.startsWith('ip_pend:'))
      .reduce((total, [, members]) => total + members.size, 0);
  return { redis, calls, lost, failing, sendCount, pending };
}

function model(config: Record<string, unknown> = {}) {
  const clock = new FixedClock('2026-10-18T10:00:00+08:00');
  const store = modelRedis(clock);
  const { logger, lines } = memoryLogger();
  const risk = createSmsRisk({
    clock,
    redis: store.redis,
    logger,
    config: {
      configValue: (_appId: string, key: string) =>
        Promise.resolve(key in config ? { value: config[key], version: 1 } : null),
    },
    crypto: ephemeralSmsRiskIndex(),
  });
  const ip = { appId: 'couli', clientIp: IP };
  const reserve = async () => {
    const admission = await risk.admitIp(ip);
    if (admission.code !== 0) throw new Error('refused');
    return admission.reservation;
  };
  /** One accepted send as identity runs it: reserve, then recordAccepted with the reservation. */
  const acceptedSend = async () => {
    await risk.recordAccepted({ ...ip, reservation: await reserve() });
  };
  return { clock, store, risk, ip, lines, reserve, acceptedSend };
}

it('[AC-B1-11g#11] A reply lost, B reserves and accepts with its own id: B turns only its own record; after A cleans up the count equals the sends', async () => {
  const m = model();
  for (let i = 0; i < 18; i++) await m.risk.recordAccepted(m.ip);
  expect(m.store.sendCount()).toBe(18);
  // A's reservation runs but its reply is lost; before A's clean-up, B goes all the way.
  m.store.lost.set('ip_reserve', async () => {
    expect(m.store.pending()).toBe(1);
    await m.acceptedSend();
    // B's acceptance took B's own record: A's is still in flight, 18 + A + B.
    expect(m.store.pending()).toBe(1);
    expect(m.store.sendCount()).toBe(20);
  });
  expect(await m.risk.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 1 });
  // A's clean-up found and dropped A's own record: 19 counted, 19 sent.
  expect(m.store.pending()).toBe(0);
  expect(m.store.sendCount()).toBe(19);
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 0 });
});

it('[AC-B1-11g#11] a reservation whose release also fails counts at its reservation time until it leaves the window (stricter)', async () => {
  const m = model({ 'sms.ip_sends_per_hour': 1 });
  m.store.lost.set('ip_reserve', async () => {
    m.store.failing.push('ip_release');
  });
  expect(await m.risk.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(m.store.pending()).toBe(1);
  m.clock.advanceMs(61_000);
  expect(await m.risk.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 3540 });
  m.clock.set('2026-10-18T11:00:00+08:00');
  expect(await m.risk.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 1 });
  m.clock.set('2026-10-18T11:00:01+08:00');
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 0 });
});

it('[AC-B1-11g#11] r5: the 20th send is accepted but both record attempts fail; the 21st stays 42901 at 61 s and 59 min, passes after the window', async () => {
  const m = model();
  for (let i = 0; i < 19; i++) await m.risk.recordAccepted(m.ip);
  const twentieth = await m.reserve();
  m.store.failing.push('ip_accept', 'ip_accept');
  await m.risk.recordAccepted({ ...m.ip, reservation: twentieth });
  expect(m.store.pending()).toBe(1);
  expect(m.store.sendCount()).toBe(20);
  m.clock.advanceMs(61_000);
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 42901 });
  m.clock.set('2026-10-18T10:59:00+08:00');
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 42901 });
  m.clock.set('2026-10-18T11:00:01+08:00');
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 0 });
});

it('[AC-B1-11g#12] a slow acceptance stamps the record with the acceptance time: reserved 10:00:00, accepted 10:00:09 → 11:00:01 waits 9 s', async () => {
  const m = model({ 'sms.ip_sends_per_hour': 1 });
  const reservation = await m.reserve();
  m.clock.set('2026-10-18T10:00:09+08:00');
  await m.risk.recordAccepted({ ...m.ip, reservation });
  expect(m.store.sendCount()).toBe(1);
  m.clock.set('2026-10-18T11:00:01+08:00');
  expect(await m.risk.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 9 });
  m.clock.set('2026-10-18T11:00:10+08:00');
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 0 });
});

it("[AC-B1-11g#11] r4: A accepted, then a Redis blip fails B's record once; the retry records B: counted = sent", async () => {
  const m = model();
  for (let i = 0; i < 18; i++) await m.risk.recordAccepted(m.ip);
  const a = await m.reserve();
  const b = await m.reserve();
  await m.risk.recordAccepted({ ...m.ip, reservation: a });
  m.store.failing.push('ip_accept');
  await m.risk.recordAccepted({ ...m.ip, reservation: b });
  expect(m.store.pending()).toBe(0);
  expect(m.store.sendCount()).toBe(20);
  // Later nothing drops: both sends stay counted, the 21st is refused.
  m.clock.advanceMs(61_000);
  expect(await m.risk.admitIp(m.ip)).toMatchObject({ code: 42901 });
  expect(m.store.sendCount()).toBe(20);
});

it('[AC-B1-11g#11] a lost acceptance reply is retried without counting the send twice', async () => {
  const m = model();
  const reservation = await m.reserve();
  m.store.lost.set('ip_accept', async () => undefined);
  await m.risk.recordAccepted({ ...m.ip, reservation });
  expect(m.store.pending()).toBe(0);
  expect(m.store.sendCount()).toBe(1);
});

it('[AC-B1-11g#19] with a reservation whose record is gone a sent record is added and no other in-flight record moves', async () => {
  const m = model();
  const other = await m.reserve();
  await m.risk.recordAccepted({ ...m.ip, reservation: 'gone' });
  expect(m.store.pending()).toBe(1);
  expect(m.store.sendCount()).toBe(2);
  await m.risk.releaseIp({ ...m.ip, reservation: other });
  expect(m.store.sendCount()).toBe(1);
});

it('[AC-B1-11g#19] a direct two-argument recordAccepted keeps the old path: the oldest in-flight record becomes sent', async () => {
  const m = model();
  await m.acceptedSend();
  const first = await m.reserve();
  const second = await m.reserve();
  expect(m.store.sendCount()).toBe(3);
  await m.risk.recordAccepted(m.ip);
  expect(m.store.sendCount()).toBe(3);
  expect(m.store.pending()).toBe(1);
  // The record turned was the oldest (first); the second's release drops its own.
  await m.risk.releaseIp({ ...m.ip, reservation: second });
  expect(m.store.sendCount()).toBe(2);
  // first's own record is gone: its release does nothing more.
  await m.risk.releaseIp({ ...m.ip, reservation: first });
  expect(m.store.sendCount()).toBe(2);
  await m.risk.recordAccepted({ appId: 'couli' });
  expect(m.store.sendCount()).toBe(2);
});

it('[AC-B1-11g#13] admitAndReserve reserves the IP, then judges the device; a device refusal releases exactly that reservation', async () => {
  const m = model();
  const request = { appId: 'couli', deviceHash: 'ab'.repeat(32), phone: '13912345678' };
  expect(await m.risk.admitAndReserve({ ...request, clientIp: IP })).toMatchObject({
    code: 0,
    reservation: expect.any(String),
  });
  expect(m.store.calls.map((call) => call.label)).toEqual(['ip_reserve', 'dev']);
  expect(m.store.sendCount()).toBe(1);
  m.store.calls.length = 0;
  expect(await m.risk.admitAndReserve(request)).toEqual({ code: 0 });
  expect(m.store.calls.map((call) => call.label)).toEqual(['dev']);
});

it('[AC-B1-11g#10] admitIp answers 42901 with the later IP release; no store refuses; logs carry no IP', async () => {
  const m = model({ 'sms.ip_sends_per_hour': 1 });
  await m.acceptedSend();
  m.clock.advanceMs(1_000);
  expect(await m.risk.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 3600 });
  const { logger } = memoryLogger();
  const bare = createSmsRisk({
    clock: m.clock,
    redis: null,
    logger,
    config: { configValue: () => Promise.resolve(null) },
    crypto: ephemeralSmsRiskIndex(),
  });
  expect(await bare.admitIp(m.ip)).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(JSON.stringify(m.store.calls)).not.toContain(IP);
  expect(m.lines.join('')).not.toContain(IP);
});
