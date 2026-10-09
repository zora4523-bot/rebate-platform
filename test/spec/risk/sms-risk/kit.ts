import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  createSmsRisk,
  type SmsRiskOptions,
  type SmsRiskRequest,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { keys, withRedis, type RawRedis, type Server } from '../rate-limit/kit.ts';

export { acquire, type Server } from '../rate-limit/kit.ts';
export { hash } from '../device-register/kit.ts';
let nextPhone = 0;
/** Unique, valid synthetic numbers within each test worker; avoids random quota collisions. */
export function phone(): string {
  nextPhone++;
  return `139${String(nextPhone).padStart(8, '0')}`;
}
export const IP = '192.0.2.81';
export const OTHER_IP = '192.0.2.82';

export async function withRisk(server: Server, run: (f: RiskFixture) => Promise<void>) {
  await withRedis(server, async (base) => {
    const values = new Map<string, unknown>();
    const reads: string[] = [];
    const digests: { value: string; context: string; digest: string }[] = [];
    const key = randomBytes(32);
    const options: SmsRiskOptions = {
      clock: base.clock,
      redis: base.handles[0]!,
      logger: base.options.logger,
      config: {
        async configValue(app, name) {
          reads.push(name);
          return values.has(`${app}:${name}`)
            ? { value: values.get(`${app}:${name}`), version: 1 }
            : null;
        },
      },
      crypto: {
        blindIndex(value, context) {
          const digest = createHmac('sha256', key).update(`${context}\0${value}`).digest('hex');
          digests.push({ value, context, digest });
          return digest;
        },
      },
    };
    base.clock.set('2031-05-06T09:00:00Z');
    try {
      await run({
        ...base,
        options,
        reads,
        digests,
        config: (name, value, app = base.app) => values.set(`${app}:${name}`, value),
        // Construct in the test body so the skeleton is a per-test failure, never a hook error.
        service: (overrides = {}) => createSmsRisk({ ...options, ...overrides }),
        request: (overrides = {}) => ({
          appId: base.app,
          deviceHash: randomBytes(32).toString('hex'),
          phone: '13812345678',
          clientIp: IP,
          ...overrides,
        }),
        registered: (service, clientIp = IP) =>
          service.recordRegistered({ appId: base.app, clientIp, userId: randomUUID() }),
        keys: () => keys(base.raw, `*${base.app}*`),
      });
    } finally {
      const owned = await keys(base.raw, `*${base.app}*`);
      if (owned.length) await base.raw.call('DEL', ...owned);
    }
  });
}
type Base = Parameters<Parameters<typeof withRedis>[1]>[0];
type Service = ReturnType<typeof createSmsRisk>;
export interface RiskFixture extends Omit<Base, 'options' | 'service'> {
  options: SmsRiskOptions;
  digests: { value: string; context: string; digest: string }[];
  service(overrides?: Partial<SmsRiskOptions>): Service;
  request(overrides?: Partial<SmsRiskRequest>): SmsRiskRequest;
  registered(service: Service, clientIp?: string): Promise<void>;
}
export function alerts(lines: string[], app: string) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (line) => line['app_id'] === app && line['budget'] !== undefined && line['day'] !== undefined,
    );
}

/** Inspect Redis through public commands, without assuming implementation key names. */
export async function snapshot(raw: RawRedis, pattern: string) {
  const result: { key: string; type: string; value: unknown; ttl: number }[] = [];
  for (const key of await keys(raw, pattern)) {
    const type = String(await raw.call('TYPE', key));
    let value: unknown;
    switch (type) {
      case 'string':
        value = await raw.call('GET', key);
        break;
      case 'zset':
        value = await raw.call('ZRANGE', key, 0, -1, 'WITHSCORES');
        break;
      case 'list':
        value = await raw.call('LRANGE', key, 0, -1);
        break;
      case 'hash':
        value = await raw.call('HGETALL', key);
        break;
      case 'set':
        value = await raw.call('SMEMBERS', key);
        break;
      case 'stream':
        value = await raw.call('XRANGE', key, '-', '+');
        break;
      default:
        throw new Error(`unexpected Redis type: ${type}`);
    }
    result.push({ key, type, value, ttl: Number(await raw.call('TTL', key)) });
  }
  return result;
}
export function privateText(text: string, secrets: string[]) {
  for (const secret of secrets) expect(text).not.toContain(secret);
}
