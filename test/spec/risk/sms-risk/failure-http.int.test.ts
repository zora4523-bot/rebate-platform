import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as riskModule from '../../../../apps/api/src/modules/risk/index.ts';
import { RedisUnavailableError } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { IP, phone, privateText } from './kit.ts';
import { closeSuite, openSuite, result, withHttp } from './http-kit.ts';

let suite: Awaited<ReturnType<typeof openSuite>>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it('[AC-B1-03g#9] AppModule 的风险存储故障拒发，恢复后名额仍满三个；首次 error 与恢复 info', async () => {
  let broken = true;
  const create = riskModule.createSmsRisk;
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  // Isolate a risk-store transport outage: signature/nonce storage must remain available to
  // reach the SMS rule. Every successful command still executes against real Redis.
  const factory = vi.spyOn(riskModule, 'createSmsRisk').mockImplementation((options) => {
    const redis = options.redis;
    const logger = options.logger.child({});
    const originalError = logger.error.bind(logger);
    const originalInfo = logger.info.bind(logger);
    vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
      originalError(args[0] as object, String(args[1] ?? ''));
    });
    vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      infos.push(args);
      originalInfo(args[0] as object, String(args[1] ?? ''));
    });
    return create({
      ...options,
      logger,
      redis:
        redis === null
          ? null
          : {
              ...redis,
              namespace(name) {
                const ns = redis.namespace(name);
                return {
                  async get(key) {
                    if (broken) throw new RedisUnavailableError('command_failed');
                    return ns.get(key);
                  },
                  async set(key, value, ttl) {
                    if (broken) throw new RedisUnavailableError('command_failed');
                    return ns.set(key, value, ttl);
                  },
                  async eval(script, scriptOptions) {
                    if (broken) throw new RedisUnavailableError('command_failed');
                    return ns.eval(script, scriptOptions);
                  },
                };
              },
            },
    });
  });
  try {
    await withHttp(suite, {}, async (f) => {
      expect(factory).toHaveBeenCalled();
      const client = await f.client();
      const number = phone();
      for (let i = 0; i < 4; i++) await result(await client.send(number), 42901, 1);
      expect(f.sender.outbox()).toHaveLength(0);
      expect(errors).toHaveLength(1);
      broken = false;
      for (let i = 0; i < 3; i++) await result(await client.send(phone()), 0);
      expect(infos).toHaveLength(1);
      await result(await client.send(number), 42901, 3601);
      expect(f.sender.outbox()).toHaveLength(3);
      privateText(JSON.stringify([errors, infos]), [number, `+86${number}`, IP]);
    });
  } finally {
    factory.mockRestore();
  }
});

it('[AC-B1-03g#9][AC-B1-03g#10] 受理后计数失败只记日志，不改成功结果、不退设备名额', async () => {
  const create = riskModule.createSmsRisk;
  const number = phone();
  const record = vi.fn<riskModule.SmsRisk['recordAccepted']>(async () => {
    throw new Error(`unavailable ${number} ${IP}`);
  });
  const factory = vi.spyOn(riskModule, 'createSmsRisk').mockImplementation((options) => ({
    ...create(options),
    recordAccepted: record,
  }));
  try {
    await withHttp(suite, {}, async (f) => {
      const client = await f.client();
      await result(await client.send(number), 0);
      for (let i = 0; i < 2; i++) await result(await client.send(phone()), 0);
      expect(record).toHaveBeenCalledTimes(3);
      expect(record).toHaveBeenCalledWith({ appId: f.id, clientIp: IP });
      await result(await client.send(phone()), 42901, 3601);
      expect(f.sender.outbox()).toHaveLength(3);
      expect(
        f.lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .some((line) => line['level'] === 50),
      ).toBe(true);
      privateText(f.lines.join(''), [number, `+86${number}`]);
      privateText(
        f.lines
          .filter((line) => {
            const entry = JSON.parse(line) as Record<string, unknown>;
            return entry['msg'] !== 'incoming request' && entry['msg'] !== 'request completed';
          })
          .join(''),
        [IP],
      );
    });
  } finally {
    factory.mockRestore();
  }
});

it('[AC-B1-03g#7][AC-B1-03g#9] 新注册计数故障只记日志，真实短信登录建号仍成功', async () => {
  const create = riskModule.createSmsRisk;
  const number = phone();
  const record = vi.fn<riskModule.SmsRisk['recordRegistered']>(async () => {
    throw new Error(`unavailable ${number} ${IP}`);
  });
  const factory = vi.spyOn(riskModule, 'createSmsRisk').mockImplementation((options) => ({
    ...create(options),
    recordRegistered: record,
  }));
  try {
    await withHttp(suite, {}, async (f) => {
      const client = await f.client();
      await result(await client.send(number), 0);
      const response = await client.post('/v1/auth/login/sms', {
        phone: number,
        code: f.sender.outbox()[0]!.code,
        legal_versions: { privacy: 1, agreement: 1 },
        consent_at: f.clock.now().toISOString(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ code: 0, data: { is_new_user: true } });
      expect(record).toHaveBeenCalledExactlyOnceWith({
        appId: f.id,
        clientIp: IP,
        userId: response.json<{ data: { user_id: string } }>().data.user_id,
      });
      expect(
        f.lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .some((line) => line['level'] === 50),
      ).toBe(true);
      privateText(f.lines.join(''), [number, `+86${number}`]);
      privateText(
        f.lines
          .filter((line) => {
            const entry = JSON.parse(line) as Record<string, unknown>;
            return entry['msg'] !== 'incoming request' && entry['msg'] !== 'request completed';
          })
          .join(''),
        [IP],
      );
    });
  } finally {
    factory.mockRestore();
  }
});
