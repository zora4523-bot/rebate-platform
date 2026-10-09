import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { acquire, flatPrivate, hash, hotAlerts, withRisk, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03f#11] 第 20 个不同 device_id 告警，第 21 个不重复，24 小时后可再次告警', async () => {
  await withRisk(server, async (f) => {
    const service = f.service();
    const deviceHash = hash();
    const input = { appId: f.app, deviceHash };
    const first = { ...input, deviceId: randomUUID() };
    await service.recordSuccess(first);
    for (let i = 0; i < 25; i++) await service.recordSuccess(first);
    expect(hotAlerts(f.lines, f.app, deviceHash)).toEqual([]);
    for (let i = 1; i < 19; i++) await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, deviceHash)).toEqual([]);
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    const alerts = hotAlerts(f.lines, f.app, deviceHash);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ app_id: f.app, device_hash: deviceHash, count: 20 });
    expect(alerts[0]!['level']).toBeGreaterThanOrEqual(40);
    expect(alerts[0]!['window']).toBeDefined();
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, deviceHash)).toHaveLength(1);
    const keys = await f.keys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(await f.raw.call('PTTL', key)).toBeGreaterThan(0);
    f.clock.advanceMs(86_401_000);
    for (let i = 0; i < 19; i++) await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, deviceHash)).toHaveLength(1);
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, deviceHash)).toHaveLength(2);
    flatPrivate(hotAlerts(f.lines, f.app, deviceHash), ['192.0.2.71']);
    expect(f.reads).toContain(`${f.app}:device.hash_hot_alert_count`);
  });
});

it('[AC-B1-03f#12] 配置阈值 3；按 app 与 hash 隔离，跨连接并发到阈值只告警一次', async () => {
  await withRisk(server, async (f) => {
    f.config('device.hash_hot_alert_count', 3);
    f.config('device.hash_hot_alert_count', 3, `${f.app}_b`);
    const services = f.handles.map((redis) => f.service({ redis }));
    const deviceHash = hash();
    for (const appId of [f.app, `${f.app}_b`]) {
      for (let i = 0; i < 2; i++)
        await services[0]!.recordSuccess({ appId, deviceHash, deviceId: randomUUID() });
      expect(hotAlerts(f.lines, appId, deviceHash)).toEqual([]);
    }
    const otherHash = hash();
    await services[0]!.recordSuccess({
      appId: f.app,
      deviceHash: otherHash,
      deviceId: randomUUID(),
    });
    await Promise.all(
      services.map((s) => s.recordSuccess({ appId: f.app, deviceHash, deviceId: randomUUID() })),
    );
    expect(hotAlerts(f.lines, f.app, deviceHash)).toHaveLength(1);
    expect(hotAlerts(f.lines, f.app, deviceHash)[0]!['count']).toBe(3);
    expect(hotAlerts(f.lines, `${f.app}_b`, deviceHash)).toEqual([]);
    expect(hotAlerts(f.lines, f.app, otherHash)).toEqual([]);
    await services[1]!.recordSuccess({ appId: `${f.app}_b`, deviceHash, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, `${f.app}_b`, deviceHash)).toHaveLength(1);
  });
});

it('[AC-B1-03f#13] 24 小时是滑动计数：过期关联移出，较晚关联保留，不按整日清零', async () => {
  await withRisk(server, async (f) => {
    f.config('device.hash_hot_alert_count', 3);
    const service = f.service();
    const input = { appId: f.app, deviceHash: hash() };
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    f.clock.advanceMs(43_200_000);
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    f.clock.advanceMs(43_201_000);
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, input.deviceHash)).toEqual([]);
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, input.deviceHash)).toHaveLength(1);
    expect(hotAlerts(f.lines, f.app, input.deviceHash)[0]!['count']).toBe(3);
  });
});

for (const value of [null, 0, -2, 1.2, 'bad', {}, [], true]) {
  it(`[AC-B1-03f#14] 热点阈值坏值 ${JSON.stringify(value)} 回默认 20`, async () => {
    await withRisk(server, async (f) => {
      f.config('device.hash_hot_alert_count', value);
      const service = f.service();
      const input = { appId: f.app, deviceHash: hash() };
      for (let i = 0; i < 19; i++)
        await service.recordSuccess({ ...input, deviceId: randomUUID() });
      expect(hotAlerts(f.lines, f.app, input.deviceHash)).toEqual([]);
      await service.recordSuccess({ ...input, deviceId: randomUUID() });
      expect(hotAlerts(f.lines, f.app, input.deviceHash)).toHaveLength(1);
      expect(hotAlerts(f.lines, f.app, input.deviceHash)[0]!['count']).toBe(20);
    });
  });
}

it('[AC-B1-03f#15] 热点配置读取失败回默认 20，不误报存储故障', async () => {
  await withRisk(server, async (f) => {
    const service = f.service({
      config: {
        configValue: async () => {
          throw new Error('configuration unavailable');
        },
      },
    });
    const input = { appId: f.app, deviceHash: hash() };
    for (let i = 0; i < 19; i++) await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, input.deviceHash)).toEqual([]);
    await service.recordSuccess({ ...input, deviceId: randomUUID() });
    expect(hotAlerts(f.lines, f.app, input.deviceHash)).toHaveLength(1);
    expect(
      f.lines
        .map((line) => JSON.parse(line) as { level: number })
        .filter((line) => line.level === 50),
    ).toEqual([]);
  });
});
