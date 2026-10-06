// B1-19c 的 CLI 边界；业务校验、验证器与审计事务由既有服务负责。
// 所有用例直接 await run，不能把骨架异常 catch 成非零退出码而造成假绿。
import { expect, it } from 'vitest';
import { run } from '../../../../apps/api/scripts/union-pids.ts';
import {
  ACCOUNT,
  ADMIN,
  APP,
  CODE,
  EVIDENCE,
  EXPLICIT,
  GENERATED,
  PID,
  START,
  WRITES,
  accountRow,
  argv,
  fixture,
  pidRow,
} from './kit.ts';

for (const command of WRITES) {
  it(`[AC-B1-19c#1] ${command.name}: 交互码与身份、业务参数及生成的重试键传给唯一服务写方法`, async () => {
    const f = fixture();
    const args = argv(command);
    const before = [...args];
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    expect(args).toEqual(before);
    expect(f.readCode).toHaveBeenCalledTimes(1);
    expect(f.newIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(f.writeCount()).toBe(1);
    expect(f.service[command.method].mock.calls[0]?.[0]).toMatchObject({
      ...command.expected,
      appId: APP,
      adminId: ADMIN,
      code: CODE,
      ip: null,
      idempotencyKey: GENERATED,
    });
    expect(f.readCode.mock.invocationCallOrder[0]).toBeLessThan(
      f.service[command.method].mock.invocationCallOrder[0]!,
    );
    expect(f.printed()).toContain(GENERATED);
    expect(f.printed()).toContain(command.name === 'register-account' ? ACCOUNT : PID);
    expect(f.printed()).not.toContain(CODE);
    expect(f.errors).toEqual([]);
  });

  it(`[AC-B1-19c#2] ${command.name}: 显式键不被替换，重试仍重新取动态码`, async () => {
    const f = fixture();
    const args = [
      ...argv(command),
      '--idempotency-key',
      EXPLICIT,
      ...(command.name === 'confirm-hjy' ? ['--confirmed-at', START] : []),
    ];
    f.readCode.mockResolvedValueOnce(CODE).mockResolvedValueOnce('359152');
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    f.clock.advanceMs(30_000);
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    expect(f.newIdempotencyKey).not.toHaveBeenCalled();
    expect(f.readCode).toHaveBeenCalledTimes(2);
    expect(
      f.service[command.method].mock.calls.map(([input]) => ({
        code: input.code,
        idempotencyKey: input.idempotencyKey,
      })),
    ).toEqual([
      { code: CODE, idempotencyKey: EXPLICIT },
      { code: '359152', idempotencyKey: EXPLICIT },
    ]);
    expect(f.printed()).toContain(EXPLICIT);
    expect(f.printed()).not.toContain(CODE);
    expect(f.printed()).not.toContain('359152');
    if (command.name === 'confirm-hjy') {
      expect(f.service.confirmHjyIgnore.mock.calls.map(([input]) => input.confirmedAt)).toEqual([
        new Date(START),
        new Date(START),
      ]);
    }
  });

  it(`[AC-B1-19c#3] ${command.name}: 服务调用前输出重试键，失败不自动重发或泄漏原始异常`, async () => {
    const f = fixture();
    const sensitive = `synthetic-password ${CODE} synthetic-credential`;
    let printedBeforeService = '';
    f.service[command.method].mockImplementation(async () => {
      printedBeforeService = f.printed();
      throw new Error(sensitive, { cause: { password: sensitive } });
    });
    const result = await run(argv(command), f.deps);
    expect(Number.isInteger(result.exitCode)).toBe(true);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(f.writeCount()).toBe(1);
    expect(printedBeforeService).toContain(GENERATED);
    if (command.name === 'confirm-hjy') expect(printedBeforeService).toContain(START);
    expect(f.errors.length).toBeGreaterThan(0);
    for (const value of [CODE, 'synthetic-password', 'synthetic-credential']) {
      expect(f.printed()).not.toContain(value);
    }
  });

  for (const mode of ['non-tty', 'cancel', 'read-error'] as const) {
    it(`[AC-B1-19c#4] ${command.name}: ${mode} 不发起任何写入`, async () => {
      const f = fixture();
      if (mode === 'cancel') f.readCode.mockResolvedValue(null);
      if (mode === 'read-error') f.readCode.mockRejectedValue(new Error(`synthetic-input ${CODE}`));
      const result = await run(argv(command), {
        ...f.deps,
        terminal: { ...f.deps.terminal, isTTY: mode !== 'non-tty' },
      });
      expect(result.exitCode).toBeGreaterThan(0);
      expect(f.writeCount()).toBe(0);
      if (mode === 'non-tty') expect(f.readCode).not.toHaveBeenCalled();
      expect(f.printed()).not.toContain(CODE);
    });
  }

  for (const flag of ['--app', '--admin']) {
    it(`[AC-B1-19c#5] ${command.name}: 缺少 ${flag} 不读码、不写入`, async () => {
      const f = fixture();
      const args = argv(command);
      args.splice(args.indexOf(flag), 2);
      expect((await run(args, f.deps)).exitCode).toBeGreaterThan(0);
      expect(f.readCode).not.toHaveBeenCalled();
      expect(f.writeCount()).toBe(0);
    });
  }
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-19c#6] %s 的 PID 保持原值且 siteId 为 null',
  async (platform) => {
    const f = fixture();
    expect(
      await run(
        [
          'register-pid',
          '--app',
          APP,
          '--admin',
          ADMIN,
          '--platform',
          platform,
          '--union-account-id',
          ACCOUNT,
          '--pid',
          'synthetic-000-pid',
          '--pid-scene',
          'self_buy',
        ],
        f.deps,
      ),
    ).toEqual({ exitCode: 0 });
    expect(f.service.registerPid.mock.calls[0]?.[0]).toMatchObject({
      platform,
      siteId: null,
      pid: 'synthetic-000-pid',
      pidScene: 'self_buy',
      unionAccountId: ACCOUNT,
    });
  },
);

it.each(['self_buy', 'share', 'agent', 'taolijin', 'fallback', 'query'])(
  '[AC-B1-19c#7] 场景 %s 不被 CLI 改写',
  async (scene) => {
    const f = fixture();
    const args = argv(WRITES[1]);
    args[args.indexOf('--pid-scene') + 1] = scene;
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    expect(f.service.registerPid.mock.calls[0]?.[0].pidScene).toBe(scene);
  },
);

it('[AC-B1-19c#8] 花卷云确认默认时间在交互完成后读取注入 Clock', async () => {
  const f = fixture();
  f.readCode.mockImplementation(async () => {
    f.clock.advanceMs(120_000);
    return CODE;
  });
  expect(await run(argv(WRITES[2]), f.deps)).toEqual({ exitCode: 0 });
  expect(f.service.confirmHjyIgnore.mock.calls[0]?.[0]).toMatchObject({
    confirmedAt: new Date('2031-05-06T07:10:09.000Z'),
    evidencePath: EVIDENCE,
  });
});

it('[AC-B1-19c#9] 显式带时区确认时间、授权到期时间保持同一时刻', async () => {
  const f = fixture();
  const instant = '2031-05-06T15:08:09+08:00';
  expect(await run([...argv(WRITES[2]), '--confirmed-at', instant], f.deps)).toEqual({
    exitCode: 0,
  });
  expect(f.service.confirmHjyIgnore.mock.calls[0]?.[0].confirmedAt).toEqual(new Date(START));
  expect(await run([...argv(WRITES[0]), '--auth-expires-at', instant], f.deps)).toEqual({
    exitCode: 0,
  });
  expect(f.service.registerAccount.mock.calls[0]?.[0].authExpiresAt).toEqual(new Date(START));
});

it('[AC-B1-19c#27] 两次独立写操作各自产生新重试键，不缓存上一条命令的键', async () => {
  const f = fixture();
  f.newIdempotencyKey.mockReturnValueOnce(GENERATED).mockReturnValueOnce(EXPLICIT);
  expect(await run(argv(WRITES[0]), f.deps)).toEqual({ exitCode: 0 });
  expect(await run(argv(WRITES[0]), f.deps)).toEqual({ exitCode: 0 });
  expect(f.newIdempotencyKey).toHaveBeenCalledTimes(2);
  expect(f.service.registerAccount.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
    GENERATED,
    EXPLICIT,
  ]);
});

it.each(['expiring', 'expired'])(
  '[AC-B1-19c#28] 账号授权状态 %s 原样传给服务',
  async (authStatus) => {
    const f = fixture();
    const args = argv(WRITES[0]);
    args[args.indexOf('--auth-status') + 1] = authStatus;
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    expect(f.service.registerAccount.mock.calls[0]?.[0].authStatus).toBe(authStatus);
  },
);

const invalidArguments = [
  [],
  ['delete', '--app', APP, '--pid-id', PID],
  ['delete-pid', '--app', APP, '--pid-id', PID],
  ['delete-account', '--app', APP, '--union-account-id', ACCOUNT],
  [...argv(WRITES[1]), '--status', 'active'],
  [...argv(WRITES[0]), '--sync-start-at', START],
  [...argv(WRITES[3]), '--verified', 'true'],
  [...argv(WRITES[3]), '--is-super', 'true'],
  [...argv(WRITES[3]), '--code', CODE],
  [...argv(WRITES[3]), `--totp=${CODE}`],
  [...argv(WRITES[3]), '--password', 'synthetic-password'],
  [...argv(WRITES[3]), '--idempotency-key', 'bad key'],
  [...argv(WRITES[3]), '--idempotency-key'],
  ['confirm-hjy', '--app', APP, '--admin', ADMIN, '--pid-id', PID],
  [...argv(WRITES[2]), '--confirmed-at', 'not-a-date'],
  [...argv(WRITES[0]), '--auth-expires-at', 'not-a-date'],
  [...argv(WRITES[3]), 'unexpected-positional'],
];
it.each(invalidArguments.map((args, index) => ({ args, index })))(
  '[AC-B1-19c#10] 非法参数案例 $index 在读取动态码前拒绝，错误不复述敏感参数',
  async ({ args }) => {
    const f = fixture();
    expect((await run(args, f.deps)).exitCode).toBeGreaterThan(0);
    expect(f.writeCount()).toBe(0);
    expect(f.readCode).not.toHaveBeenCalled();
    expect(f.printed()).not.toContain(CODE);
    expect(f.printed()).not.toContain('synthetic-password');
  },
);

for (const [name, method] of [
  ['list-accounts', 'listAccounts'],
  ['list-pids', 'listPids'],
] as const) {
  it(`[AC-B1-19c#11] ${name}: 非交互读取指定 app/platform，不取码、不生成重试键、不写入`, async () => {
    const f = fixture();
    const result = await run([name, '--app', APP, '--platform', 'jd'], {
      ...f.deps,
      terminal: { ...f.deps.terminal, isTTY: false },
    });
    expect(result).toEqual({ exitCode: 0 });
    expect(f.queries[method]).toHaveBeenCalledExactlyOnceWith({ appId: APP, platform: 'jd' });
    expect(f.readCode).not.toHaveBeenCalled();
    expect(f.newIdempotencyKey).not.toHaveBeenCalled();
    expect(f.writeCount()).toBe(0);
    expect(f.printed()).toContain(name === 'list-accounts' ? ACCOUNT : PID);
    expect(f.printed()).toContain(APP);
    expect(f.printed()).toContain('jd');
  });

  it(`[AC-B1-19c#12] ${name}: 空列表成功，查询异常非零且不泄露原始报错`, async () => {
    const f = fixture();
    f.queries[method]
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error(`synthetic-password ${CODE}`));
    expect(await run([name, '--app', APP], f.deps)).toEqual({ exitCode: 0 });
    expect((await run([name, '--app', APP], f.deps)).exitCode).toBeGreaterThan(0);
    expect(f.printed()).not.toContain('synthetic-password');
    expect(f.printed()).not.toContain(CODE);
    expect(f.writeCount()).toBe(0);
  });

  it(`[AC-B1-19c#13] ${name}: 必须指定 app，不能无界列出所有租户`, async () => {
    const f = fixture();
    expect((await run([name], f.deps)).exitCode).toBeGreaterThan(0);
    expect(f.queries[method]).not.toHaveBeenCalled();
    expect(f.writeCount()).toBe(0);
  });
}

it('[AC-B1-19c#14] 列出全部三种状态及花卷云证据，不能只返回 active', async () => {
  const f = fixture();
  f.queries.listPids.mockResolvedValue(
    ['pending', 'active', 'retired'].map((status, index) => ({
      ...pidRow(),
      status,
      pid: `synthetic-${status}-${index}`,
      site_id: '000',
      hjy_ignore_evidence_path: EVIDENCE,
      hjy_ignore_confirmed_at: new Date(START),
    })),
  );
  expect(await run(['list-pids', '--app', APP], f.deps)).toEqual({ exitCode: 0 });
  expect(f.queries.listPids).toHaveBeenCalledExactlyOnceWith({ appId: APP });
  for (const value of [
    'pending',
    'active',
    'retired',
    EVIDENCE,
    START,
    ACCOUNT,
    'self_buy',
    '000',
  ]) {
    expect(f.printed()).toContain(value);
  }
});

it('[AC-B1-19c#15] 列表和写入结果只输出安全字段，不序列化上游诊断及额外凭据', async () => {
  const f = fixture();
  const unsafe = {
    ...accountRow(),
    last_probe_error: `synthetic-password ${CODE}`,
    password: 'synthetic-password',
    credentials: 'synthetic-credential',
    totp: CODE,
  };
  f.queries.listAccounts.mockResolvedValue([unsafe]);
  f.service.registerAccount.mockResolvedValue(unsafe);
  expect(await run(['list-accounts', '--app', APP], f.deps)).toEqual({ exitCode: 0 });
  expect(await run(argv(WRITES[0]), f.deps)).toEqual({ exitCode: 0 });
  expect(f.printed()).toContain(ACCOUNT);
  for (const value of [CODE, 'synthetic-password', 'synthetic-credential'])
    expect(f.printed()).not.toContain(value);
});
