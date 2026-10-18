import { expect, it, vi } from 'vitest';
import { APP, OTHER_APP, NORMAL, PLATFORMS, fixture, item, version, viewer } from '../fixtures.ts';

const BEFORE = '2026-10-31T23:59:59+08:00';
const AFTER = '2026-11-01T00:00:00+08:00';

// 删除任务不改实现或放置骨架。每个场景最后核对 live-only 接口，
// 现有实现因仍暴露 prepare 而断言失败；前面的断言同时保护原有 live 行为。
it('[AC-B2-03n#1] 报价器只提供 live 报价，返回对象及原型链上不存在 prepare', async () => {
  const f = fixture();
  expect((await f.quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(500n);
  expect('prepare' in f.quoter).toBe(false);
});

it('[AC-B2-03n#2] BR-CALC-20 同一 live-only 报价器并发处理不同 app 和用户，各用自己的时刻与端口数据', async () => {
  const f = fixture();
  const aOld = version({
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 1000 })),
  });
  const aNew = version({
    rule_version_id: 'app-a-new',
    effective_from: new Date(AFTER),
    rules: version().rules.map((row) => ({ ...row, r_own_bp: 2000 })),
    reserves: aOld.reserves,
  });
  const bOld = version({ rule_version_id: 'app-b-old' });
  const bNew = version({
    rule_version_id: 'app-b-new',
    effective_from: new Date(AFTER),
    rules: version().rules.map((row) => ({
      ...row,
      r_own_bp: row.level === 'L3' ? 4000 : 3000,
    })),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 2500 })),
  });
  f.versions.set(APP, [aOld, aNew]);
  f.versions.set(OTHER_APP, [bOld, bNew]);
  f.userLevels.set(`${OTHER_APP}/viewer-b`, 'L3');
  const bConfig = new Map(f.values);
  bConfig.set('tech_fee_bp', { taobao: 2000, jd: 0, pdd: 0 });
  f.configByApp.set(OTHER_APP, bConfig);

  // A 的规则读取挂起，B 在新版本生效后启动并先完成；不用计时器或真实 I/O。
  const heldA = Promise.withResolvers<void>();
  f.publishedVersions.mockImplementation(async (appId) => {
    if (appId === APP) await heldA.promise;
    return f.versions.get(appId) ?? [];
  });
  const now = vi.spyOn(f.clock, 'now');
  const completed: string[] = [];
  f.clock.set(BEFORE);
  const a = f.quoter.quote(item(), viewer({ userId: 'viewer-l1' }), NORMAL).then((quote) => {
    completed.push(APP);
    return quote;
  });
  f.clock.set(AFTER);
  const b = f.quoter
    .quote(item(), viewer({ appId: OTHER_APP, userId: 'viewer-b' }), NORMAL)
    .then((quote) => {
      completed.push(OTHER_APP);
      return quote;
    })
    .finally(() => heldA.resolve());
  const [quoteA, quoteB] = await Promise.all([a, b]);

  expect(completed).toEqual([OTHER_APP, APP]);
  // A: N=1000，预留后 B=900，L1 5000bp → 450。
  // B: N=800，预留后 B=600，新版本 L3 4000bp → 240。
  expect([quoteA.rebateMinFen, quoteA.rebateMaxFen]).toEqual([450n, 450n]);
  expect([quoteB.rebateMinFen, quoteB.rebateMaxFen]).toEqual([240n, 240n]);
  expect(now.mock.results.map((result) => result.value)).toEqual([
    new Date(BEFORE),
    new Date(AFTER),
  ]);
  expect(f.publishedVersions.mock.calls).toEqual([[APP], [OTHER_APP]]);
  expect(f.levelOf.mock.calls).toEqual([
    [{ appId: APP, userId: 'viewer-l1' }],
    [{ appId: OTHER_APP, userId: 'viewer-b' }],
  ]);
  for (const appId of [APP, OTHER_APP]) {
    const keys = f.configValue.mock.calls
      .filter(([scope]) => scope === appId)
      .map(([, key]) => key);
    expect(keys).toContain('commission.platforms');
    expect(keys).toContain('tech_fee_bp');
  }
  expect('prepare' in f.quoter).toBe(false);
});

it('[AC-B2-03n#3] BR-CALC-20 live-only 报价在任何端口读取前取一次时钟，读端口跨版本不改变本次报价', async () => {
  for (const advancingPort of ['rules', 'levels', 'config'] as const) {
    const f = fixture();
    const old = version();
    const next = version({
      rule_version_id: 'next',
      effective_from: new Date(AFTER),
      rules: old.rules.map((row) => ({ ...row, r_own_bp: 4000 })),
    });
    f.clock.set(BEFORE);
    const events: string[] = [];
    const readNow = f.clock.now.bind(f.clock);
    const now = vi.spyOn(f.clock, 'now').mockImplementation(() => {
      events.push('clock');
      return readNow();
    });
    function portRead(port: string): void {
      events.push(port);
      if (port === advancingPort) f.clock.set(AFTER);
    }
    f.publishedVersions.mockImplementation(async () => {
      portRead('rules');
      return [old, next];
    });
    f.levelOf.mockImplementation(async () => {
      portRead('levels');
      return 'L1';
    });
    f.configValue.mockImplementation(async (_appId, key) => {
      portRead('config');
      const value = f.values.get(key);
      return value === undefined ? null : { value, version: 1 };
    });

    const first = await f.quoter.quote(item(), viewer({ userId: 'viewer-l1' }), NORMAL);
    expect(events[0]).toBe('clock');
    expect(events).toEqual(expect.arrayContaining(['rules', 'levels', 'config']));
    expect(now).toHaveBeenCalledTimes(1);
    expect(first.rebateMaxFen).toBe(500n);

    // 同一实例下一次报价必须重新取时钟、读取三个端口，并选取新版本。
    events.length = 0;
    const second = await f.quoter.quote(item(), viewer({ userId: 'viewer-l1' }), NORMAL);
    expect(events[0]).toBe('clock');
    expect(events).toEqual(expect.arrayContaining(['rules', 'levels', 'config']));
    expect(now).toHaveBeenCalledTimes(2);
    expect(second.rebateMaxFen).toBe(400n);
    expect(first.rebateMaxFen).toBe(500n);
  }
  expect('prepare' in fixture().quoter).toBe(false);
});
