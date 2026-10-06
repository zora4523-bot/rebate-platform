import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { createRedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { createSmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import {
  createFakeSmsSender,
  smsCredentialEnvNames,
} from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import { limited, makeHmac, memoryLogger, phone, redisConnection } from './kit.ts';

it('[BR-ID-05] Redis 不可用时拒绝发码，返回正整数等待时间且不调用供应商', async () => {
  const { logger } = memoryLogger();
  const handle = await createRedisHandle(redisConnection('redis://127.0.0.1:1/0'), {
    logger,
    transportFactory: () => ({
      connect: async () => {
        throw new Error('offline');
      },
      call: async () => {
        throw new Error('offline');
      },
      quit: async () => undefined,
      disconnect: () => undefined,
    }),
  });
  try {
    let calls = 0;
    const sender = createFakeSmsSender('test');
    const service = createSmsCodeService({
      redis: handle!,
      clock: new FixedClock('2026-10-06T10:00:00+08:00'),
      logger,
      hmac: makeHmac(),
      config: { configValue: async () => null },
      sender: {
        send: async (message) => {
          calls++;
          return sender.send(message);
        },
      },
    });
    limited(await service.send({ app_id: 'couli', phone: phone(), purpose: 'login' }));
    expect(calls).toBe(0);
    expect(sender.outbox()).toEqual([]);
  } finally {
    await handle?.close();
  }
});

it.each(['local', 'test'])('[BR-ID-05] %s 假短信适配器可注入三种结果并保留发件箱', async (env) => {
  const sender = createFakeSmsSender(env);
  for (const outcome of ['accepted', 'rejected', 'unknown'] as const) {
    sender.enqueueResult(outcome);
    const message = { app_id: 'couli', phone: phone(), purpose: 'login' as const, code: '042019' };
    const before = sender.outbox().length;
    expect(await sender.send(message)).toBe(outcome);
    if (outcome === 'rejected') expect(sender.outbox()).toHaveLength(before);
    else expect(sender.outbox().at(-1)).toEqual(message);
  }
});

it('[BR-ID-05] 假适配器不能在 staging/prod 启用', () => {
  for (const env of ['staging', 'prod']) {
    // Construct a permitted adapter first so the skeleton cannot satisfy a generic throw test.
    expect(createFakeSmsSender('test').outbox()).toEqual([]);
    expect(() => createFakeSmsSender(env)).toThrow();
  }
});

it('[BR-ID-05] 声明的 SMS 密钥使 local/test 拒启，仅报告变量名；保留其他通道保护', () => {
  const names = smsCredentialEnvNames();
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toMatch(/^SMS_/);
  for (const env of ['local', 'test']) {
    for (const name of [
      ...names,
      'UNION_TEST_SECRET',
      'ALIPAY_TEST_PRIVATE_KEY',
      'BANK_TEST_ACCESS_KEY',
    ]) {
      const value = `sentinel-${randomUUID()}`;
      let error: unknown;
      try {
        loadConfig({ APP_ENV: env, [name]: value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toContain(name);
      expect(String(error)).not.toContain(value);
    }
  }
});

it('[BR-ID-05] captcha_token 与手机号的结构化日志字段脱敏', () => {
  const { logger, lines } = memoryLogger();
  const number = phone();
  const token = `captcha-${randomUUID()}`;
  logger.info({ phone: number, captcha_token: token }, 'sms test');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join('')).not.toContain(number);
  expect(lines.join('')).not.toContain(token);
});
