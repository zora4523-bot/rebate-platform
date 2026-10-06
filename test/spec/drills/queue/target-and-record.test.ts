import { expect, it } from 'vitest';
import {
  DrillError,
  assertLocalTarget,
  parseDrillArgs,
  recordPath,
  runDrill,
  type DrillErrorCode,
} from '../../../../infra/drills/queue/drill.ts';
import { LOCAL, drillOptions, fakeTime, makeStub } from './stub.ts';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectDrillError(error: unknown, code: DrillErrorCode): void {
  expect(error).toBeInstanceOf(DrillError);
  expect((error as DrillError).code).toBe(code);
}

it.each([
  ['postgres://couli_app@127.0.0.1:54329/couli', 'redis://127.0.0.1:63790'],
  ['postgresql://couli_app@LOCALHOST:54329/couli', 'redis://localhost:63790/0'],
  ['postgres://couli_app@[::1]:54329/couli', 'redis://[::1]:63790'],
])('[QA-05 只在本地栈] 回环地址放行：%s', (pgUrl, redisUrl) => {
  expect(assertLocalTarget({ pgUrl, redisUrl })).toBeUndefined();
});

it.each([
  ['postgres://couli_app@db.staging.example:5432/couli', LOCAL.redisUrl],
  ['postgres://couli_app@10.0.0.5:5432/couli', LOCAL.redisUrl],
  ['postgres://couli_app@127.0.0.1.example:5432/couli', LOCAL.redisUrl],
  [LOCAL.pgUrl, 'redis://redis.prod.example:6379'],
])('[QA-05 不碰 staging / prod] 非回环目标报 not_local：%s %s', (pgUrl, redisUrl) => {
  expectDrillError(
    caught(() => assertLocalTarget({ pgUrl, redisUrl })),
    'not_local',
  );
});

it.each([
  ['http://127.0.0.1:54329/couli', LOCAL.redisUrl],
  [LOCAL.pgUrl, 'postgres://127.0.0.1:63790'],
  ['not a url', LOCAL.redisUrl],
])('[QA-05 只在本地栈] 协议不对或无法解析报 invalid_option：%s %s', (pgUrl, redisUrl) => {
  expectDrillError(
    caught(() => assertLocalTarget({ pgUrl, redisUrl })),
    'invalid_option',
  );
});

it('[QA-05 不碰 staging / prod] runDrill 对非本地目标在任何执行器动作之前拒绝', async () => {
  const stub = makeStub();
  const options = drillOptions(stub, fakeTime(), {
    target: { pgUrl: 'postgres://couli_app@pg.staging.example/couli', redisUrl: LOCAL.redisUrl },
  });
  expectDrillError(await runDrill(options).catch((error: unknown) => error), 'not_local');
  expect(stub.calls).toEqual([]);
});

it.each([{ jobsBefore: 0 }, { jobsDuring: 501 }, { pollMs: 50 }, { drainTimeoutMs: 500 }])(
  '[QA-05 演练参数] 参数越界 %o 时 invalid_option 且不动执行器',
  async (overrides) => {
    const stub = makeStub();
    const options = drillOptions(stub, fakeTime(), overrides);
    expectDrillError(await runDrill(options).catch((error: unknown) => error), 'invalid_option');
    expect(stub.calls).toEqual([]);
  },
);

it('[QA-05 演练记录写运行目录] 记录文件名按场景与开始时刻（UTC）', () => {
  expect(
    recordPath({
      repoRoot: '/w/rebate-platform',
      runsDir: '/w/couli-runs',
      scenario: 'redis-down',
      startedAt: new Date(Date.UTC(2026, 9, 6, 1, 2, 3)),
    }),
  ).toBe('/w/couli-runs/drills/queue/redis-down-20261006T010203Z.json');
  expect(
    recordPath({
      repoRoot: '/w/rebate-platform',
      runsDir: '/w/rebate-platform-runs',
      scenario: 'worker-kill',
      startedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    }),
  ).toBe('/w/rebate-platform-runs/drills/queue/worker-kill-20260102T030405Z.json');
});

it.each([
  ['/w/rebate-platform', 'record_in_repo'],
  ['/w/rebate-platform/.tmp/runs', 'record_in_repo'],
  ['/w/other/../rebate-platform/x', 'record_in_repo'],
  ['relative/runs', 'invalid_option'],
] as const)('[QA-05 演练记录不入库] runsDir %s → %s', (runsDir, code) => {
  expectDrillError(
    caught(() =>
      recordPath({
        repoRoot: '/w/rebate-platform',
        runsDir,
        scenario: 'worker-stop',
        startedAt: new Date(Date.UTC(2026, 9, 6)),
      }),
    ),
    code,
  );
});

it('[QA-05 演练脚本] 命令行：场景与运行目录必填，--jobs 默认 20', () => {
  expect(parseDrillArgs(['--scenario', 'queue-disconnect', '--runs-dir', '/w/couli-runs'])).toEqual(
    { scenario: 'queue-disconnect', runsDir: '/w/couli-runs', jobs: 20 },
  );
  expect(
    parseDrillArgs(['--runs-dir', '/w/couli-runs', '--jobs', '5', '--scenario', 'worker-kill']),
  ).toEqual({ scenario: 'worker-kill', runsDir: '/w/couli-runs', jobs: 5 });
});

it.each([
  [['--scenario', 'db-failover', '--runs-dir', '/w/r']],
  [['--runs-dir', '/w/r']],
  [['--scenario', 'redis-down']],
  [['--scenario', 'redis-down', '--runs-dir', 'r']],
  [['--scenario', 'redis-down', '--runs-dir', '/w/r', '--jobs', '0']],
  [['--scenario', 'redis-down', '--runs-dir', '/w/r', '--jobs', '2.5']],
  [['--scenario', 'redis-down', '--scenario', 'worker-stop', '--runs-dir', '/w/r']],
  [['--scenario', 'redis-down', '--runs-dir', '/w/r', '--prod']],
])('[QA-05 演练脚本] 命令行参数不合法 %j → invalid_option', (argv) => {
  expectDrillError(
    caught(() => parseDrillArgs(argv)),
    'invalid_option',
  );
});
