import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { RedisUnavailableError } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import * as risk from '../../../../apps/api/src/modules/risk/index.ts';
import { validateErrorResponse } from '../../identity/sms-codes/http-kit.ts';
import { closeSuite, hash, IP, limited, openSuite, registered, withHttp } from './kit.ts';

let suite: Awaited<ReturnType<typeof openSuite>>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it('[AC-B1-03f#25] 无效哈希返回 20001 不占 IP 名额，随后一台成功、再一台 42901', async () => {
  // specs/device-hash.vectors.json: invalid_hash_seeds[0].device_hash
  const invalidHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  await withHttp(suite, { 'device.ip_register_per_hour': 1 }, async (f) => {
    const invalid = await f.send(IP, invalidHash);
    expect(invalid.statusCode).toBe(400);
    // Both routes reference the shared ClientError response in the contract.
    await validateErrorResponse(invalid);
    expect(invalid.json()).toMatchObject({ code: 20001, data: { fields: ['device_hash'] } });
    expect(JSON.stringify(invalid.json())).not.toContain('device_id');
    expect(JSON.stringify(invalid.json())).not.toContain('install_secret');
    expect(await f.rows()).toEqual([]);

    const validHash = hash();
    const device = await registered(await f.send(IP, validHash));
    expect(await f.rows()).toEqual([
      expect.objectContaining({ id: device.device_id, device_hash: validHash }),
    ]);
    await limited(await f.send(IP, hash()), 3601);
    expect(await f.rows()).toEqual([
      expect.objectContaining({ id: device.device_id, device_hash: validHash }),
    ]);
  });
});

it('[AC-B1-03f#27] 占位成功后热点记数 Redis 失败，HTTP 仍成功且只落一行', async () => {
  const create = risk.createDeviceRegistrationRisk;
  const recorded =
    vi.fn<(input: Parameters<risk.DeviceRegistrationRisk['recordSuccess']>[0]) => void>();
  const failHotCommand = vi.fn(() => {
    throw new RedisUnavailableError('command_failed');
  });
  const admissions: risk.DeviceRegistrationAdmission[] = [];
  // Decorate the public port only to scope the transport fault. All risk methods still
  // execute their real implementations; reservation commands go to the disposable Redis.
  const factory = vi.spyOn(risk, 'createDeviceRegistrationRisk').mockImplementation((options) => {
    let recording = false;
    const redis = options.redis;
    const service = create({
      ...options,
      redis:
        redis === null
          ? null
          : {
              ...redis,
              namespace(name) {
                const namespace = redis.namespace(name);
                return {
                  async get(key) {
                    if (recording) failHotCommand();
                    return namespace.get(key);
                  },
                  async set(key, value, ttlSeconds) {
                    if (recording) failHotCommand();
                    return namespace.set(key, value, ttlSeconds);
                  },
                  async eval(script, scriptOptions) {
                    if (recording) failHotCommand();
                    return namespace.eval(script, scriptOptions);
                  },
                };
              },
            },
    });
    return {
      ...service,
      async reserve(input) {
        const admission = await service.reserve(input);
        admissions.push(admission);
        return admission;
      },
      async recordSuccess(input) {
        recorded(input);
        recording = true;
        try {
          await service.recordSuccess(input);
        } finally {
          recording = false;
        }
      },
    };
  });
  try {
    await withHttp(
      suite,
      { 'device.ip_register_per_hour': 1, 'device.hash_hot_alert_count': 1 },
      async (f) => {
        const deviceHash = hash();
        const device = await registered(await f.send(IP, deviceHash));
        expect(admissions).toEqual([expect.objectContaining({ code: 0 })]);
        expect(recorded).toHaveBeenCalledExactlyOnceWith({
          appId: f.id,
          deviceHash,
          deviceId: device.device_id,
        });
        expect(failHotCommand).toHaveBeenCalled();
        expect(await f.rows()).toEqual([
          expect.objectContaining({ id: device.device_id, device_hash: deviceHash }),
        ]);
        // A failed alert must not release the slot of the device already committed.
        await limited(await f.send(IP, hash()), 3601);
        expect(recorded).toHaveBeenCalledTimes(1);
        expect(await f.rows()).toHaveLength(1);
      },
    );
  } finally {
    factory.mockRestore();
  }
});
