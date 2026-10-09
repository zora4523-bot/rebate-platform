// Unit tests of the device registration risk ports (B1-03f §10). Redis is a scripted RedisHandle
// (no connection): these tests pin the arguments handed to the scripts and how replies and
// failures are read; the scripts themselves run against a real Redis in the rule tests
// (test/spec/risk/device-register/).
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  FixedClock,
  RedisUnavailableError,
  createRootLogger,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import { createDeviceRegistrationRisk } from './device-registration.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

const APP = 'couli';
const IP = '192.0.2.10';
const HASH = createHash('sha256').update('device').digest('hex');

interface Call {
  namespace: string;
  options: RedisScriptOptions;
}

function setup(
  reply: (call: Call) => unknown,
  values: Record<string, unknown> = {},
  redisMissing = false,
) {
  const calls: Call[] = [];
  const redis: RedisHandle = {
    namespace: (namespace) => ({
      get: () => Promise.reject(new Error('unused')),
      set: () => Promise.reject(new Error('unused')),
      eval: async (_script, options) => {
        const call = { namespace, options };
        calls.push(call);
        return reply(call);
      },
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  const config: RateLimitConfigReader = {
    configValue: async (_app, key) =>
      Object.hasOwn(values, key) ? { value: values[key], version: 1 } : null,
  };
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const clock = new FixedClock('2031-05-06T09:00:00.000Z');
  const risk = createDeviceRegistrationRisk({
    clock,
    redis: redisMissing ? null : redis,
    logger,
    config,
    crypto: { blindIndex: (value, context) => `${'ab'.repeat(16)}${context}${value}` },
  });
  return { risk, calls, lines, clock };
}

it('[AC-B1-03f#1] reserves with the Clock, the default limit and a key of app and IP digest', async () => {
  const { risk, calls } = setup(() => [1, 0]);
  const result = await risk.reserve({ appId: APP, clientIp: IP });
  expect(result).toEqual({
    code: 0,
    reservation: { appId: APP, ipDigest: 'ab'.repeat(16), token: expect.any(String) },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.namespace).toBe('ip_reg');
  expect(calls[0]!.options.keys).toEqual([`${APP}:${'ab'.repeat(16)}`]);
  expect(calls[0]!.options.keys.join('')).not.toContain(IP);
  expect(calls[0]!.options.args.slice(0, 3)).toEqual([
    String(Date.parse('2031-05-06T09:00:00.000Z')),
    '30',
    '3600000',
  ]);
});

it('[AC-B1-03f#26] a refusal rounds the wait up to whole seconds, at least 1', async () => {
  const { risk } = setup(() => [0, 1_200_001]);
  expect(await risk.reserve({ appId: APP, clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1201,
  });
});

for (const value of [0, -1, 1.5, 'bad', null, true, 100_001]) {
  it(`[AC-B1-03f#4] a bad limit ${JSON.stringify(value)} uses the default 30`, async () => {
    const { risk, calls } = setup(() => [1, 0], { 'device.ip_register_per_hour': value });
    await risk.reserve({ appId: APP, clientIp: IP });
    expect(calls[0]!.options.args[1]).toBe('30');
  });
}

it('[AC-B1-03f#9] store failures refuse with 1 s, log one error per outage and one recovery', async () => {
  let broken = true;
  const { risk, lines } = setup(() => {
    if (broken) throw new RedisUnavailableError('command_failed');
    return [1, 0];
  });
  for (let i = 0; i < 3; i++) {
    expect(await risk.reserve({ appId: APP, clientIp: IP })).toEqual({
      code: 42901,
      retryAfterSec: 1,
    });
  }
  broken = false;
  expect((await risk.reserve({ appId: APP, clientIp: IP })).code).toBe(0);
  await risk.reserve({ appId: APP, clientIp: IP });
  expect(lines.map((line) => [line['level'], line['msg']])).toEqual([
    [50, 'device_register_store_unavailable'],
    [30, 'device_register_store_recovered'],
  ]);
  expect(JSON.stringify(lines)).not.toContain(IP);
});

it('[AC-B1-03f#9] an unexpected script reply is a store failure, never a pass', async () => {
  const { risk } = setup(() => 'OK');
  expect(await risk.reserve({ appId: APP, clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
});

it('[AC-B1-03f#10] without Redis: refuse, and the hot count is a no-op', async () => {
  const { risk, calls } = setup(() => [1, 0], {}, true);
  expect(await risk.reserve({ appId: APP, clientIp: IP })).toEqual({
    code: 42901,
    retryAfterSec: 1,
  });
  await expect(
    risk.recordSuccess({ appId: APP, deviceHash: HASH, deviceId: 'd' }),
  ).resolves.toBeUndefined();
  expect(calls).toEqual([]);
});

it('[AC-B1-03f#8] reconcile keeps the slot when the lookup fails and releases on confirmed absence', async () => {
  const { risk, calls } = setup(() => 1);
  const reservation = { appId: APP, ipDigest: 'ab'.repeat(16), token: 't1' };
  await risk.reconcile(reservation, 'd1', () => Promise.reject(new Error('lookup lost')));
  await risk.reconcile(reservation, 'd1', async () => true);
  expect(calls).toEqual([]);
  await risk.reconcile(reservation, 'd1', async () => false);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.options.keys).toEqual([`${APP}:${'ab'.repeat(16)}`]);
  expect(calls[0]!.options.args).toEqual(['t1']);
});

it('[AC-B1-03f#11] the hot count alerts once with flat fields and swallows store failures', async () => {
  let reply: unknown = [20, 1];
  const { risk, calls, lines } = setup(
    () => {
      if (reply === 'fail') throw new RedisUnavailableError('command_failed');
      return reply;
    },
    { 'device.hash_hot_alert_count': 7 },
  );
  await risk.recordSuccess({ appId: APP, deviceHash: HASH, deviceId: 'd1' });
  expect(calls[0]!.namespace).toBe('dev_hot');
  expect(calls[0]!.options.keys).toEqual([`${APP}:${HASH}`, `${APP}:${HASH}:alerted`]);
  expect(calls[0]!.options.args.slice(1, 4)).toEqual(['86400000', '7', 'd1']);
  expect(lines).toEqual([
    expect.objectContaining({
      level: 40,
      msg: 'device_hash_hot_alert',
      app_id: APP,
      device_hash: HASH,
      count: 20,
      window: '24h',
    }),
  ]);
  reply = [21, 0];
  await risk.recordSuccess({ appId: APP, deviceHash: HASH, deviceId: 'd2' });
  expect(lines).toHaveLength(1);
  reply = 'fail';
  await expect(
    risk.recordSuccess({ appId: APP, deviceHash: HASH, deviceId: 'd3' }),
  ).resolves.toBeUndefined();
  expect(lines[1]).toMatchObject({ level: 40, msg: 'device_hash_hot_count_failed' });
  expect(lines[1]!['device_hash']).toBeUndefined();
});
