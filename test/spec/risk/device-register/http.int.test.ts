import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { REDIS, type RedisHandle } from '../../../../apps/api/src/modules/platform/index.ts';
import { ROOT } from '../rate-limit/kit.ts';
import type { HttpApp } from '../rate-limit/http-kit.ts';
import {
  closeSuite,
  flatPrivate,
  hash,
  hotAlerts,
  IP,
  limited,
  openSuite,
  registered,
  withHttp,
} from './kit.ts';

let suite: Awaited<ReturnType<typeof openSuite>>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it('[AC-B1-03f#16] 真实 HTTP 第 30 台成功、第 31 台拒绝，无 device_id 和新增行；整点仍拒绝，滑出后恢复', async () => {
  await withHttp(suite, {}, async (f) => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add((await registered(await f.send())).device_id);
    expect(ids.size).toBe(30);
    expect(await f.rows()).toHaveLength(30);
    await limited(await f.send(), 3601);
    expect(await f.rows()).toHaveLength(30);
    f.clock.advanceMs(3_600_000);
    await limited(await f.send(), 1);
    expect(await f.rows()).toHaveLength(30);
    f.clock.advanceMs(1000);
    await registered(await f.send());
    expect(await f.rows()).toHaveLength(31);
  });
});

it('[AC-B1-03f#17] content 配置上限 2，换 hash 或伪造转发头不能绕过；换真实 IP 或 app 可注册', async () => {
  await withHttp(suite, { 'device.ip_register_per_hour': 2 }, async (f) => {
    await registered(await f.send());
    await registered(await f.send());
    await limited(
      await f.send(IP, hash(), f.id, {
        'x-forwarded-for': '192.0.2.99',
        'x-real-ip': '192.0.2.98',
      }),
      3601,
    );
    expect(await f.rows()).toHaveLength(2);
    await registered(await f.send('192.0.2.72'));
    await registered(await f.send(IP, hash(), `${f.id}_b`));
    expect(await f.rows()).toHaveLength(3);
    await limited(await f.send(), 3601);
  });
});

it('[AC-B1-03f#18] HTTP 配置坏值回默认 30，不拒绝全部也不无限放行', async () => {
  await withHttp(suite, { 'device.ip_register_per_hour': -1 }, async (f) => {
    for (let i = 0; i < 30; i++) await registered(await f.send());
    await limited(await f.send(), 3601);
    expect(await f.rows()).toHaveLength(30);
  });
});

it('[AC-B1-03f#19] 真实 HTTP/Redis 已有 29 台时两个并发请求只有一个成功且只新增一行', async () => {
  await withHttp(suite, {}, async (f) => {
    for (let i = 0; i < 29; i++) await registered(await f.send());
    const responses = await Promise.all([f.send(), f.send()]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 429]);
    for (const response of responses) {
      if (response.statusCode === 200) await registered(response);
      else await limited(response, 3601);
    }
    expect(await f.rows()).toHaveLength(30);
  });
});

// Runtime import keeps Nest's parameter decorators out of the erasable-only spec TS project.
// This is the existing persistence seam, not a replacement registration/risk implementation.
async function persistence() {
  return (await import(
    new URL('apps/api/src/modules/identity/infra/devices.repository.ts', ROOT).href
  )) as {
    DevicesRepository: {
      prototype: {
        insert(device: { id: string; appId: string }): Promise<void>;
        findUnrevoked(id: string): Promise<unknown>;
      };
    };
  };
}

for (const fault of ['before_insert', 'constraint_rejection'] as const) {
  it(`[AC-B1-03f#20] ${fault} 明确失败撤销名额，下一次成功且随后仍正确限流`, async () => {
    await withHttp(
      suite,
      { 'device.ip_register_per_hour': 1, 'device.hash_hot_alert_count': 1 },
      async (f) => {
        const deviceHash = hash();
        const { DevicesRepository } = await persistence();
        const insert = vi.spyOn(DevicesRepository.prototype, 'insert');
        insert.mockRejectedValueOnce(
          Object.assign(new Error('injected registration failure'), {
            code: fault === 'constraint_rejection' ? '23505' : 'TEST_BEFORE_INSERT',
          }),
        );
        try {
          const response = await f.send(IP, deviceHash);
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(JSON.stringify(response.json())).not.toContain('install_secret');
          expect(await f.rows()).toHaveLength(0);
          expect(hotAlerts(f.lines, f.id, deviceHash)).toEqual([]);
          await registered(await f.send(IP, deviceHash));
          expect(await f.rows()).toHaveLength(1);
          expect(hotAlerts(f.lines, f.id, deviceHash)).toHaveLength(1);
          await limited(await f.send(IP, deviceHash), 3601);
          expect(hotAlerts(f.lines, f.id, deviceHash)).toHaveLength(1);
          expect(insert).toHaveBeenCalledTimes(2);
          expect(await f.rows()).toHaveLength(1);
        } finally {
          insert.mockRestore();
        }
      },
    );
  });
}

for (const committed of [true, false]) {
  it(`[AC-B1-03f#21] 提交确认丢失，核实 ${committed ? '已写入则保留' : '未写入则撤销'} 占位`, async () => {
    await withHttp(suite, { 'device.ip_register_per_hour': 1 }, async (f) => {
      const { DevicesRepository } = await persistence();
      const original = DevicesRepository.prototype.insert;
      let issued: string | undefined;
      const insert = vi.spyOn(DevicesRepository.prototype, 'insert');
      insert.mockImplementationOnce(async function (
        this: typeof DevicesRepository.prototype,
        device,
      ) {
        issued = device.id;
        if (committed) await original.call(this, device);
        throw Object.assign(new Error('connection lost awaiting commit acknowledgement'), {
          code: 'ECONNRESET',
        });
      });
      try {
        // The task leaves the uncertain request's HTTP response policy to identity.
        await Promise.allSettled([f.send()]);
        expect(issued).toEqual(expect.any(String));
        expect(
          f.queries.some((query) => {
            const text = JSON.stringify(query);
            return text.includes('devices') && text.includes(issued!);
          }),
        ).toBe(true);
        const rows = await f.rows();
        expect(rows).toHaveLength(committed ? 1 : 0);
        if (committed) {
          expect(rows[0]!.id).toBe(issued);
          await limited(await f.send(), 3601);
          expect(insert).toHaveBeenCalledTimes(1);
        } else {
          await registered(await f.send());
          await limited(await f.send(), 3601);
          expect(insert).toHaveBeenCalledTimes(2);
        }
        expect(await f.rows()).toHaveLength(1);
      } finally {
        insert.mockRestore();
      }
    });
  });
}

it('[AC-B1-03f#22] Redis 不可用时不调用 devices 插入，无签发响应，连续拒绝只记一次 error', async () => {
  await withHttp(suite, {}, async (f) => {
    const redis = f.app.get<RedisHandle>(REDIS);
    const { DevicesRepository } = await persistence();
    const insert = vi.spyOn(DevicesRepository.prototype, 'insert');
    // Closing the shared handle invalidates namespaces already obtained during assembly.
    await redis.close();
    try {
      for (let i = 0; i < 3; i++) await limited(await f.send());
      expect(insert).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual([]);
      const errors = f.lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line['level'] === 50);
      expect(errors).toHaveLength(1);
      flatPrivate(errors, [IP]);
    } finally {
      insert.mockRestore();
    }
  });
});

it('[AC-B1-03f#24] AppModule 未提供 Redis 时仍拒绝注册，不生成安装密钥、不写 devices', async () => {
  const bootstrap = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', options: Record<string, unknown>): Promise<HttpApp>;
  };
  const issuance = (await import(
    new URL('apps/api/src/modules/identity/infra/issue.ts', ROOT).href
  )) as {
    newInstallSecret(): string;
  };
  const original = bootstrap.createHttpApp;
  const build = vi
    .spyOn(bootstrap, 'createHttpApp')
    .mockImplementation((entry, options) => original(entry, { ...options, redisUrl: null }));
  const issue = vi.spyOn(issuance, 'newInstallSecret');
  try {
    await withHttp(suite, {}, async (f) => {
      await limited(await f.send());
      expect(issue).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual([]);
    });
  } finally {
    issue.mockRestore();
    build.mockRestore();
  }
});

for (const threshold of [20, 3]) {
  it(`[AC-B1-03f#23] HTTP 同 hash 第 ${threshold} 台告警，第 ${threshold + 1} 台仍成功且不重复，过窗重计`, async () => {
    await withHttp(
      suite,
      threshold === 20 ? {} : { 'device.hash_hot_alert_count': threshold },
      async (f) => {
        const deviceHash = hash();
        const secrets: string[] = [];
        for (let i = 0; i < threshold - 1; i++)
          secrets.push((await registered(await f.send(IP, deviceHash))).install_secret);
        expect(hotAlerts(f.lines, f.id, deviceHash)).toEqual([]);
        secrets.push((await registered(await f.send(IP, deviceHash))).install_secret);
        expect(hotAlerts(f.lines, f.id, deviceHash)).toHaveLength(1);
        expect(hotAlerts(f.lines, f.id, deviceHash)[0]).toMatchObject({
          app_id: f.id,
          device_hash: deviceHash,
          count: threshold,
        });
        secrets.push((await registered(await f.send(IP, deviceHash))).install_secret);
        expect(hotAlerts(f.lines, f.id, deviceHash)).toHaveLength(1);
        expect(await f.rows()).toHaveLength(threshold + 1);
        f.clock.advanceMs(86_401_000);
        for (let i = 0; i < threshold - 1; i++) await registered(await f.send(IP, deviceHash));
        expect(hotAlerts(f.lines, f.id, deviceHash)).toHaveLength(1);
        await registered(await f.send(IP, deviceHash));
        expect(hotAlerts(f.lines, f.id, deviceHash)).toHaveLength(2);
        flatPrivate(hotAlerts(f.lines, f.id, deviceHash), [IP, ...secrets]);
      },
    );
  });
}
