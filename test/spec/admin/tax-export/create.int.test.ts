// B2-08e · creating a quarterly tax export (规划/08 BR-WDR-21; contract adminCreateExport; task §9.1
// to §9.4). The CT-24zi gate answered every such request 20001 on resource; these go through the real
// admin entry. A refusal the route schema already gave before this task ends in a valid create, so
// every case is red until the branch is open.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { grant } from '../accounts/kit.ts';
import { error, ok, type View } from '../exports/kit.ts';
import {
  DENIED,
  FULL,
  FULL_POINT,
  harness,
  MASKED,
  MASKED_POINTS,
  open,
  PURPOSE,
  quarterRefused,
  shapeRefused,
  smsToken,
  untouched,
} from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B2-08e#1] tax_withdrawals 不再按 resource 拒绝：202 pending，存下季度，generate 在创建事务内入队', async () => {
  const f = await open(h);
  const view = await ok<View>(await f.create(MASKED));
  expect(view).toMatchObject({
    resource: 'tax_withdrawals',
    masked: true,
    status: 'pending',
    progress: null,
    failure_reason: null,
    file_name: null,
    row_count: null,
    expires_at: null,
    created_by: f.actor.id,
  });
  expect(view.filters_summary).toMatch(/2026.*(Q4|第四季度|第 ?4 ?季度|四季度)/);
  const [row] = await f.tasks();
  expect(row).toMatchObject({
    public_id: view.id,
    resource: 'tax_withdrawals',
    masked: true,
    filters: { quarter: '2026-Q4' },
    status: 'pending',
  });
  expect(f.send.mock.calls.filter(([queue]) => queue === 'export')).toEqual([
    [
      'export',
      'generate',
      { appId: f.appId, taskId: row!.id },
      expect.objectContaining({ trx: expect.anything() }),
    ],
  ]);
});

it.each([
  [{ quarter: '2026-Q5' }],
  [{ quarter: '2026-Q0' }],
  [{ quarter: '2026Q4' }],
  [{ quarter: '2026-q4' }],
  [{ quarter: '' }],
  [{}],
] as const)(
  '[AC-B2-08e#2] 季度格式错 %j → 20001 且无副作用，随后合法季度可创建',
  async (filters) => {
    const f = await open(h);
    await shapeRefused(await f.create({ ...MASKED, filters }), 'filters.quarter');
    await untouched(f);
    expect((await ok<View>(await f.create(MASKED))).resource).toBe('tax_withdrawals');
  },
);

it.each(['2025-Q4', '2101-Q1', '0000-Q1', '9999-Q4'])(
  '[AC-B2-08e#3] 年份越出 2026..2100 的季度 %s → 20001，不建任务',
  async (quarter) => {
    const f = await open(h);
    await quarterRefused(await f.create({ ...MASKED, filters: { quarter } }));
    await untouched(f);
  },
);

it.each(['2026-Q1', '2100-Q4'])('[AC-B2-08e#4] 区间两端的季度 %s 可创建', async (quarter) => {
  const f = await open(h);
  await ok<View>(await f.create({ ...MASKED, filters: { quarter } }));
  expect((await f.tasks())[0]).toMatchObject({ filters: { quarter } });
});

it.each([
  [[]],
  [['export']],
  [['fund.view']],
  [[FULL_POINT]],
  [['export', FULL_POINT]],
  [['fund.view', FULL_POINT]],
] as const)(
  '[AC-B2-08e#5] 脱敏版要 export + fund.view，只持 %j → 10403 且无副作用',
  async (points) => {
    const f = await open(h, points);
    await error(await f.create(MASKED), 10403, DENIED);
    await untouched(f);
  },
);

it('[AC-B2-08e#6] fund.* 全持也不隐含 tax.export_full：全量版 10403，不核销令牌，勾选后同一令牌可用', async () => {
  const f = await open(h, [
    ...MASKED_POINTS,
    'fund.adjust',
    'fund.writeoff',
    'fund.settle_adjust',
    'fund.recon',
    'fund.cash_entry',
    'pii.reveal_phone',
    'pii.reveal_identity',
  ]);
  const token = await f.token();
  await error(await f.create(FULL, token), 10403, DENIED);
  await untouched(f);
  await grant(h, f.actor, f.actor, [FULL_POINT]);
  expect((await ok<View>(await f.create(FULL, token))).masked).toBe(false);
});

it('[AC-B2-08e#7] 全量版只要 tax.export_full：不需 export、fund.view，202 后令牌已核销', async () => {
  const f = await open(h, [FULL_POINT]);
  const token = await f.token();
  const view = await ok<View>(await f.create(FULL, token));
  expect(view).toMatchObject({ resource: 'tax_withdrawals', masked: false, status: 'pending' });
  await error(await f.create(FULL, token), 10003, { tier: 'totp' });
  expect(await f.tasks()).toHaveLength(1);
});

// Only a tax task's create opens to tax.export_full; the other resources keep export. These refusals
// already hold before this task, so each case ends in a create that is red until the branch is open.
it.each([
  [[FULL_POINT], { resource: 'audit_logs', filters: {} }],
  [[FULL_POINT], { resource: 'users', filters: {} }],
  [[FULL_POINT, 'user.list'], { resource: 'users', filters: {} }],
] as const)(
  '[AC-B2-08e#45] tax.export_full 不替代 export：持 %j 建 %j → 10403 且不建任务，全量版照常可建',
  async (points, body) => {
    const f = await open(h, points);
    await error(await f.create(body), 10403, DENIED);
    await untouched(f);
    expect((await ok<View>(await f.create(FULL, await f.token()))).masked).toBe(false);
  },
);

it('[AC-B2-08e#8] 超管自带两种版本的权限', async () => {
  const f = await open(h, [], true);
  expect((await ok<View>(await f.create(MASKED))).masked).toBe(true);
  expect((await ok<View>(await f.create(FULL, await f.token()))).masked).toBe(false);
});

it.each(['缺令牌', '令牌无效', '令牌过期', '短信档'] as const)(
  '[AC-B2-08e#9] 全量版 %s → 10003 tier=totp，不建任务',
  async (kind) => {
    const f = await open(h, [FULL_POINT]);
    let token: string | undefined;
    if (kind === '令牌无效') token = 'invalid-step-up';
    if (kind === '令牌过期') {
      token = await f.token();
      f.clock.advanceMs(300_000);
    }
    if (kind === '短信档') token = await smsToken(f);
    await error(await f.create(FULL, token), 10003, { tier: 'totp' });
    await untouched(f);
  },
);

it('[AC-B2-08e#10] 全量版缺 reason → 20001 [reason]，令牌不核销', async () => {
  const f = await open(h, [FULL_POINT]);
  const token = await f.token();
  await error(await f.create({ ...MASKED, unmasked: true }, token), 20001, { fields: ['reason'] });
  await untouched(f);
  expect((await ok<View>(await f.create(FULL, token))).masked).toBe(false);
});

it.each(['', '理'.repeat(201)])(
  '[AC-B2-08e#11] 全量版 reason 长度不在 1–200 → 20001，令牌不核销（%j）',
  async (reason) => {
    const f = await open(h, [FULL_POINT]);
    const token = await f.token();
    await shapeRefused(await f.create({ ...FULL, reason }, token), 'reason');
    await untouched(f);
    expect((await ok<View>(await f.create({ ...FULL, reason: '理' }, token))).masked).toBe(false);
  },
);

it.each([[{ ...MASKED, reason: PURPOSE }], [{ ...MASKED, unmasked: false, reason: PURPOSE }]])(
  '[AC-B2-08e#12] 脱敏版带 reason %j → 20001 [reason]',
  async (body) => {
    const f = await open(h);
    await error(await f.create(body), 20001, { fields: ['reason'] });
    await untouched(f);
  },
);

it('[AC-B2-08e#13] 脱敏版不要 step-up：不查也不核销所带令牌，unmasked=false 同脱敏', async () => {
  const f = await open(h, [...MASKED_POINTS, FULL_POINT]);
  const token = await f.token();
  expect((await ok<View>(await f.create(MASKED, token))).masked).toBe(true);
  expect((await ok<View>(await f.create(MASKED, 'invalid-step-up'))).masked).toBe(true);
  expect((await ok<View>(await f.create({ ...MASKED, unmasked: false }))).masked).toBe(true);
  expect((await ok<View>(await f.create(FULL, token))).masked).toBe(false);
  expect(await f.tasks()).toHaveLength(4);
});
