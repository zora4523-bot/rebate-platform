import { expect, it } from 'vitest';
import { claimDraftCard } from '../../../../apps/api/src/modules/agent/tools/claim/index.ts';
import { context, draftOf, expectCard, fixture, log, NOW, ORDER_NO, setup } from './kit.ts';

it('[AC-B3-08d#5][BR-AI-01][BR-AI-03] 只读当前 app 与用户，默认窗口为固定时钟向前 720 小时', async () => {
  const f = setup();
  const ctx = context({ appId: 'synthetic-app-b', userId: 'synthetic-user-b' });
  expect(
    draftOf(await f.execute({ platform: 'jd', order_no: ORDER_NO }, ctx))['click_times'],
  ).toEqual([]);
  expect(f.config).toHaveBeenCalledWith('synthetic-app-b', 'claim.window_hours');
  expect(f.read).toHaveBeenCalledTimes(1);
  // 任务书 §9：默认 claim.window_hours=720；期望不调用生产 claimWindowHours 计算。
  expect(f.read).toHaveBeenCalledWith({
    app_id: 'synthetic-app-b',
    user_id: 'synthetic-user-b',
    from: new Date('2026-09-23T12:00:00.000Z'),
    to: new Date(NOW),
  });
});

it('[AC-B3-08d#5][BR-AI-01] 同平台成功 convert/open 才回显时间，按新到旧排列且不生成证据摘要', async () => {
  const f = setup();
  f.read.mockResolvedValue({
    logs: [
      log('2026-10-22T10:00:00.000Z', { event: 'convert' }),
      log('2026-10-23T11:00:00.000Z', { platform: 'pdd' }),
      log('2026-10-23T10:00:00.000Z', { event: 'register' }),
      log('2026-10-23T09:00:00.000Z', { event: 'precompute' }),
      log('2026-10-23T08:00:00.000Z', { result_code: 30101 }),
      log('2026-10-23T07:00:00.000Z', { event: 'convert', result_code: -1 }),
      log('2026-10-23T06:00:00.000Z', { platform: null }),
      log('2026-10-23T05:00:00.000Z'),
      // 这里只回显外跳事实；不是 orders 的证据重算，不额外按 no_rebate/scene 排除。
      log('2026-10-23T04:00:00.000Z', {
        no_rebate: true,
        no_rebate_reason: 'synthetic-reason',
        pid_scene: null,
      }),
    ],
    bindings: [
      {
        app_id: 'synthetic-app',
        user_id: 'synthetic-user',
        platform: 'jd',
        status: 'bound',
        bound_at: new Date('2026-10-23T11:59:00.000Z'),
        relation_id: 'synthetic-relation',
      },
    ],
  });
  const data = draftOf(await f.execute());
  expect(data['click_times']).toEqual([
    '2026-10-23T13:00:00.000+08:00',
    '2026-10-23T12:00:00.000+08:00',
    '2026-10-22T18:00:00.000+08:00',
  ]);
  expect(data['evidence_summary']).toBeNull();
  expect(data).not.toHaveProperty('relation_id');
});

it('[AC-B3-08d#5][BR-AI-01] 配置窗口使用闭区间，刚好落在起止时刻的外跳都回显', async () => {
  const f = setup();
  f.config.mockResolvedValue(24);
  const rows = [
    log('2026-10-22T11:59:59.999Z'),
    log('2026-10-22T12:00:00.000Z', { event: 'convert' }),
    log('2026-10-23T12:00:00.000Z'),
    log('2026-10-23T12:00:00.001Z'),
  ];
  // ClaimEntryReader 已负责区间过滤；这里只实现它的契约，不强制工具重复过滤。
  f.read.mockImplementation(async ({ from, to }) => ({
    logs: rows.filter((row) => row.created_at >= from && row.created_at <= to),
    bindings: [],
  }));
  expect(draftOf(await f.execute())['click_times']).toEqual([
    '2026-10-23T20:00:00.000+08:00',
    '2026-10-22T20:00:00.000+08:00',
  ]);
  expect(f.read).toHaveBeenCalledWith({
    app_id: 'synthetic-app',
    user_id: 'synthetic-user',
    from: new Date('2026-10-22T12:00:00.000Z'),
    to: new Date(NOW),
  });
});

it.each([undefined, null, 0, -1, 1.5, '24'])(
  '[AC-B3-08d#5][BR-AI-01] 缺失或不可用的窗口配置 %s 回落到 720 小时',
  async (value) => {
    const f = setup();
    f.config.mockResolvedValue(value);
    expect(draftOf(await f.execute())['click_times']).toEqual([]);
    expect(f.read).toHaveBeenCalledWith({
      app_id: 'synthetic-app',
      user_id: 'synthetic-user',
      from: new Date('2026-09-23T12:00:00.000Z'),
      to: new Date(NOW),
    });
  },
);

it('[AC-B3-08d#5][BR-AI-01] 配置读取异常也使用默认窗口，点击读取本身仍须成功', async () => {
  const f = setup();
  f.config.mockRejectedValue(new Error('synthetic-config-unavailable'));
  expect(draftOf(await f.execute())['click_times']).toEqual([]);
  expect(f.read).toHaveBeenCalledWith({
    app_id: 'synthetic-app',
    user_id: 'synthetic-user',
    from: new Date('2026-09-23T12:00:00.000Z'),
    to: new Date(NOW),
  });
});

it('[AC-B3-08d#5][BR-AI-01] 先筛选并排序再取最近十条，不让别的平台占用名额', async () => {
  const f = setup();
  const times = [
    '2026-10-23T00:00:00.000Z',
    '2026-10-23T01:00:00.000Z',
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T03:00:00.000Z',
    '2026-10-23T04:00:00.000Z',
    '2026-10-23T05:00:00.000Z',
    '2026-10-23T06:00:00.000Z',
    '2026-10-23T07:00:00.000Z',
    '2026-10-23T08:00:00.000Z',
    '2026-10-23T09:00:00.000Z',
    '2026-10-23T10:00:00.000Z',
    '2026-10-23T11:00:00.000Z',
  ];
  f.read.mockResolvedValue({
    logs: [
      ...times.map((at) => log(at, { platform: 'pdd' })),
      ...times.map((at, index) => log(at, { id: BigInt(index + 1) })),
    ],
    bindings: [],
  });
  // 任务书 §9 明确默认最多 10 条；固定期望不用生产代码推导。
  expect(draftOf(await f.execute())['click_times']).toEqual([
    '2026-10-23T19:00:00.000+08:00',
    '2026-10-23T18:00:00.000+08:00',
    '2026-10-23T17:00:00.000+08:00',
    '2026-10-23T16:00:00.000+08:00',
    '2026-10-23T15:00:00.000+08:00',
    '2026-10-23T14:00:00.000+08:00',
    '2026-10-23T13:00:00.000+08:00',
    '2026-10-23T12:00:00.000+08:00',
    '2026-10-23T11:00:00.000+08:00',
    '2026-10-23T10:00:00.000+08:00',
  ]);
});

it('[AC-B3-08d#5][BR-AI-01][BR-AI-03] 复用出卡函数也按本人查询，并每次读取注入时钟', async () => {
  const f = fixture();
  f.config.mockResolvedValue(24);
  f.read.mockResolvedValue({ logs: [log('2026-10-23T11:00:00.000Z')], bindings: [] });
  const input = { platform: 'jd', orderNo: ORDER_NO };
  const first = await claimDraftCard(f.deps, context(), input);
  expect(expectCard(first)['click_times']).toEqual(['2026-10-23T19:00:00.000+08:00']);
  f.clock.set('2026-10-24T12:00:00.000Z');
  f.read.mockResolvedValue({ logs: [], bindings: [] });
  const second = await claimDraftCard(
    f.deps,
    context({ appId: 'synthetic-app-b', userId: 'synthetic-user-b' }),
    input,
  );
  expect(expectCard(second)['click_times']).toEqual([]);
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.read).toHaveBeenNthCalledWith(2, {
    app_id: 'synthetic-app-b',
    user_id: 'synthetic-user-b',
    from: new Date('2026-10-23T12:00:00.000Z'),
    to: new Date('2026-10-24T12:00:00.000Z'),
  });
});
