import { expect, it } from 'vitest';
import {
  APP,
  OTHER_APP,
  CONFIG_KEYS,
  NORMAL,
  OpenReadNotPrepared,
  gate,
  item,
  plan,
  version,
  viewer,
  wiringFixture,
  withOpenReads,
} from './kit.ts';

it('[AC-B2-03d#4] 开放预读覆盖调用方和所有归属身份、全部真实配置键；事务报价三个端口零读取', async () => {
  const f = wiringFixture();
  const { quoter, ports, prepare } = await f.live();
  await withOpenReads(
    () =>
      ports.quoteReads.prepare(
        plan({
          identities: [
            { userId: 'viewer-l1', pidScene: 'share', noRebate: false },
            { userId: 'viewer-l3', pidScene: 'self_buy', noRebate: false },
            { userId: null, pidScene: 'share', noRebate: true },
            { userId: 'viewer-l1', pidScene: 'self_buy', noRebate: false },
          ],
        }),
      ),
    async () => {
      expect(f.publishedVersions).toHaveBeenCalledExactlyOnceWith(APP);
      expect(new Set(f.levelOf.mock.calls.map(([subject]) => JSON.stringify(subject)))).toEqual(
        new Set(
          ['viewer-l1', 'viewer-l2', 'viewer-l3'].map((userId) =>
            JSON.stringify({ appId: APP, userId }),
          ),
        ),
      );
      expect(f.configValue.mock.calls.map(([appId, key]) => [appId, key]).sort()).toEqual(
        CONFIG_KEYS.map((key) => [APP, key]).sort(),
      );
      f.publishedVersions.mockClear();
      f.levelOf.mockClear();
      f.configValue.mockClear();
      f.clock.advanceMs(5000);
      for (const [userId, expected] of [
        [null, 500n],
        ['viewer-l1', 500n],
        ['viewer-l2', 550n],
        ['viewer-l3', 600n],
      ] as const) {
        expect((await quoter.quote(item(), viewer({ userId }), NORMAL)).rebateMaxFen).toBe(
          expected,
        );
      }
      expect(f.publishedVersions).not.toHaveBeenCalled();
      expect(f.levelOf).not.toHaveBeenCalled();
      expect(f.configValue).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    },
  );
});

it('[AC-B2-03d#5] 预读时刻截断未来版本：跨生效时间且未来版本已撤销仍按原版本报价', async () => {
  const f = wiringFixture();
  const current = version({ effective_from: f.clock.now() });
  const future = version({
    rule_version_id: 'future',
    effective_from: new Date(f.clock.now().getTime() + 1000),
    rules: current.rules.map((row) => ({ ...row, r_own_bp: 4000 })),
  });
  f.versions.set(APP, [current, future]);
  const { quoter, ports, options } = await f.live();
  await withOpenReads(
    () => ports.quoteReads.prepare(plan()),
    async () => {
      f.clock.advanceMs(2000);
      f.versions.set(APP, [current]); // simulate revocation after the pre-read
      expect(await options.rules.publishedVersions(APP)).toEqual([current]);
      expect(
        (await quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen,
      ).toBe(550n);
      expect(f.publishedVersions).toHaveBeenCalledTimes(1);
    },
  );
});

it('[AC-B2-03d#6] 未预读的 app、user 和配置键一律 OpenReadNotPrepared，不借连接也不回退等级', async () => {
  const f = wiringFixture();
  const { quoter, ports, options } = await f.live();
  await withOpenReads(
    () => ports.quoteReads.prepare(plan()),
    async () => {
      f.publishedVersions.mockClear();
      f.levelOf.mockClear();
      f.configValue.mockClear();
      await expect(
        quoter.quote(item(), viewer({ appId: OTHER_APP }), NORMAL),
      ).rejects.toBeInstanceOf(OpenReadNotPrepared);
      await expect(
        quoter.quote(item(), viewer({ userId: 'unprepared-user' }), NORMAL),
      ).rejects.toBeInstanceOf(OpenReadNotPrepared);
      await expect(options.config.configValue(APP, 'unprepared.key')).rejects.toBeInstanceOf(
        OpenReadNotPrepared,
      );
      expect(f.publishedVersions).not.toHaveBeenCalled();
      expect(f.levelOf).not.toHaveBeenCalled();
      expect(f.configValue).not.toHaveBeenCalled();
    },
  );
});

it('[AC-B2-03d#7] 开放外逐次直读，开放结束后恢复直读，guest 使用 L1 而不查用户等级', async () => {
  const f = wiringFixture();
  const { quoter, ports, prepare } = await f.live();
  await withOpenReads(
    () => ports.quoteReads.prepare(plan()),
    async () => {
      expect((await quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(500n);
    },
  );
  f.publishedVersions.mockClear();
  f.levelOf.mockClear();
  f.configValue.mockClear();
  expect((await quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen).toBe(
    550n,
  );
  f.userLevels.set(`${APP}/viewer-l2`, 'L3');
  f.values.set('tech_fee_bp', { taobao: 1000, jd: 0, pdd: 0 });
  expect((await quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen).toBe(
    540n,
  );
  expect(f.publishedVersions).toHaveBeenCalledTimes(2);
  expect(f.levelOf).toHaveBeenCalledTimes(2);
  expect(f.configValue.mock.calls.filter(([, key]) => key === 'tech_fee_bp')).toHaveLength(2);
  f.levelOf.mockClear();
  expect((await quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(450n);
  expect(f.levelOf).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it('[AC-B2-03d#8] 两个并发开放的 app/user 预读隔离，期间搜索卡片直读最新值', async () => {
  const f = wiringFixture();
  f.versions.set(OTHER_APP, [
    version({ reserves: version().reserves.map((row) => ({ ...row, reserve_bp: 2000 })) }),
  ]);
  f.configByApp.set(OTHER_APP, new Map(f.values));
  f.userLevels.set(`${OTHER_APP}/other-user`, 'L3');
  const { quoter, ports, prepare } = await f.live();
  const aReady = gate();
  const bReady = gate();
  const finish = gate();
  const a = withOpenReads(
    () => ports.quoteReads.prepare(plan()),
    async () => {
      aReady.release();
      await finish.promise;
      expect(
        (await quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen,
      ).toBe(550n);
      await expect(
        quoter.quote(item(), viewer({ appId: OTHER_APP, userId: 'other-user' }), NORMAL),
      ).rejects.toBeInstanceOf(OpenReadNotPrepared);
    },
  );
  await aReady.promise;
  const b = withOpenReads(
    () =>
      ports.quoteReads.prepare(
        plan({ appId: OTHER_APP, callerUserId: 'other-user', identities: [] }),
      ),
    async () => {
      bReady.release();
      await finish.promise;
      expect(
        (await quoter.quote(item(), viewer({ appId: OTHER_APP, userId: 'other-user' }), NORMAL))
          .rebateMaxFen,
      ).toBe(480n);
      await expect(
        quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL),
      ).rejects.toBeInstanceOf(OpenReadNotPrepared);
    },
  );
  await bReady.promise;
  try {
    f.userLevels.set(`${APP}/viewer-l2`, 'L1');
    expect((await quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen).toBe(
      500n,
    );
    f.publishedVersions.mockClear();
    f.levelOf.mockClear();
    f.configValue.mockClear();
  } finally {
    finish.release();
    await Promise.all([a, b]);
  }
  expect(f.publishedVersions).not.toHaveBeenCalled();
  expect(f.levelOf).not.toHaveBeenCalled();
  expect(f.configValue).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it('[AC-B2-03d#9] 预读失败全部接管：事务真正读到失败端口时才原样抛错，其他身份不受影响', async () => {
  const f = wiringFixture();
  const { quoter, ports } = await f.live();
  const failed = new Error('synthetic level read failed');
  f.levelOf.mockImplementation(async ({ userId }) => {
    if (userId === 'viewer-l1') throw failed;
    return 'L2';
  });
  await withOpenReads(
    async () => {
      await expect(ports.quoteReads.prepare(plan())).resolves.toBeUndefined();
    },
    async () => {
      expect(
        (await quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen,
      ).toBe(550n);
      f.levelOf.mockClear();
      await expect(quoter.quote(item(), viewer({ userId: 'viewer-l1' }), NORMAL)).rejects.toBe(
        failed,
      );
      expect(f.levelOf).not.toHaveBeenCalled();
    },
  );
  for (const port of ['rules', 'config'] as const) {
    const error = new Error(`synthetic ${port} failure`);
    if (port === 'rules') f.publishedVersions.mockRejectedValueOnce(error);
    else
      f.configValue.mockImplementation(async () => {
        throw error;
      });
    await withOpenReads(
      async () => {
        await expect(ports.quoteReads.prepare(plan())).resolves.toBeUndefined();
      },
      async () => {
        await expect(quoter.quote(item(), viewer(), NORMAL)).rejects.toBe(error);
      },
    );
  }
});

it('[AC-B2-03d#15] 版本读取期间跨越生效点，开放仍以开始预读时的 Clock 截断未来版本', async () => {
  const f = wiringFixture();
  const current = version();
  const future = version({
    rule_version_id: 'future-during-read',
    effective_from: new Date(f.clock.now().getTime() + 1000),
    rules: current.rules.map((row) => ({ ...row, r_own_bp: 4000 })),
  });
  f.versions.set(APP, [current, future]);
  const { quoter, ports, options } = await f.live();
  // Outside an open the reader must preserve future versions for the quoter's own selection.
  expect(await options.rules.publishedVersions(APP)).toEqual([current, future]);
  f.publishedVersions.mockClear();
  f.publishedVersions.mockImplementationOnce(async () => {
    f.clock.advanceMs(2000);
    return [current, future];
  });
  await withOpenReads(
    () => ports.quoteReads.prepare(plan()),
    async () => {
      expect(await options.rules.publishedVersions(APP)).toEqual([current]);
      expect((await quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(500n);
      expect(f.publishedVersions).toHaveBeenCalledTimes(1);
    },
  );
  expect((await quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(400n);
});

it('[AC-B2-03d#16] 无已发布规则时真实报价失败，不能回退可用的演示规则或伪造零返利', async () => {
  const f = wiringFixture();
  f.values.set('demo.rebate_quote_rule', { reserve_bp: 0, self_share_bp: 2000 });
  f.versions.set(APP, []);
  const { quoter, ports } = await f.live();
  await withOpenReads(
    async () => {
      await expect(ports.quoteReads.prepare(plan())).resolves.toBeUndefined();
    },
    async () => {
      await expect(quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow(
        /no published rule version/u,
      );
      expect(f.demo).not.toHaveBeenCalled();
      expect(f.configValue.mock.calls.map(([, key]) => key)).not.toContain(
        'demo.rebate_quote_rule',
      );
    },
  );
});
