import { expect, it } from 'vitest';
import {
  assignMatchTags,
  type ResultCheckPort,
} from '../../../../apps/api/src/modules/agent/tools/match/index.ts';
import { card, fixture, flush, labels, observe } from './kit.ts';

it('[AC-B3-04d#43] rules 不调用核对端口，provider 读取失败回退 rules', async () => {
  const h = fixture();
  const input = [card(), card({ title: '合成牛奶12盒' })];
  const conditions = { spec: '24盒', relaxed: false };
  const expected = [
    { match_tag: 'matched', spec_text: '24盒' },
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ];
  expect(labels(await assignMatchTags(input, conditions, 'app-a', h.deps))).toEqual(expected);
  h.provider.mockRejectedValueOnce(new Error('synthetic-config-failure'));
  expect(labels(await assignMatchTags(input, conditions, 'app-b', h.deps))).toEqual(expected);
  expect(h.provider.mock.calls).toEqual([['app-a'], ['app-b']]);
  expect(h.check).not.toHaveBeenCalled();
});

it('[AC-B3-04d#44] Jev 一次整组核对，仅发送标题与规格，按位置降级且不排序删卡', async () => {
  const h = fixture('jev');
  const input = [
    card({ product_key: 'tb:z', title: '合成A24盒', final_price_fen: 4000 }),
    card({ product_key: 'tb:a', title: '合成B24盒', final_price_fen: 1000 }),
    card({ product_key: 'tb:m', title: '合成C24盒', final_price_fen: 3000 }),
    card({ product_key: 'tb:b', title: '合成D12盒', final_price_fen: 2000 }),
  ];
  h.check.mockResolvedValueOnce(['inconsistent', 'consistent', 'unsure', 'consistent']);
  const result = await assignMatchTags(input, { spec: '24盒', relaxed: false }, 'app-a', h.deps);
  expect(labels(result)).toEqual([
    { match_tag: 'spec_unconfirmed', spec_text: null },
    { match_tag: 'matched', spec_text: '24盒' },
    { match_tag: 'spec_unconfirmed', spec_text: null },
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
  expect(result).toEqual(input.map((item, index) => ({ ...item, ...labels(result)[index] })));
  expect(h.check).toHaveBeenCalledTimes(1);
  expect(h.check).toHaveBeenCalledWith(
    input.map(({ title }) => ({ title })),
    { spec: '24盒' },
    expect.any(AbortSignal),
  );
  expect(h.provider).toHaveBeenCalledWith('app-a');
});

it('[AC-B3-04d#45] relaxed 优先于 Jev，只有仍满足原始条件的卡可被降级', async () => {
  const h = fixture('jev');
  const input = [
    card({ product_key: 'tb:spec', title: '合成牛奶12盒' }),
    card({ product_key: 'tb:price', final_price_fen: 5001 }),
    card({ product_key: 'tb:ok' }),
  ];
  for (const verdict of ['consistent', 'inconsistent', 'unsure'] as const) {
    h.check.mockResolvedValueOnce([verdict, verdict, verdict]);
    const result = await assignMatchTags(
      input,
      { spec: '24盒', priceMaxFen: 5000, relaxed: true },
      'app-a',
      h.deps,
    );
    expect(labels(result)).toEqual([
      { match_tag: 'relaxed', spec_text: null },
      { match_tag: 'relaxed', spec_text: null },
      verdict === 'consistent'
        ? { match_tag: 'matched', spec_text: '24盒' }
        : { match_tag: 'spec_unconfirmed', spec_text: null },
    ]);
    expect(result.map((item) => item.product_key)).toEqual(input.map((item) => item.product_key));
  }
  expect(h.check).toHaveBeenCalledTimes(3);
});

it('[AC-B3-04d#46] 无 spec 的 matched 也可被 Jev 降级，不向核对端口发送价格条件', async () => {
  const h = fixture('jev');
  h.check.mockResolvedValueOnce(['inconsistent', 'unsure', 'consistent']);
  const result = await assignMatchTags(
    [card(), card(), card()],
    { priceMaxFen: 5000, relaxed: false },
    'app-a',
    h.deps,
  );
  expect(labels(result)).toEqual([
    { match_tag: 'spec_unconfirmed', spec_text: null },
    { match_tag: 'spec_unconfirmed', spec_text: null },
    { match_tag: 'matched', spec_text: null },
  ]);
  expect(h.check).toHaveBeenCalledWith(
    [{ title: '合成纯牛奶24盒' }, { title: '合成纯牛奶24盒' }, { title: '合成纯牛奶24盒' }],
    {},
    expect.any(AbortSignal),
  );
});

// 任务 §9 已指定：超时、失败、张数不符按 BR-AI-24 从严处理，待规划同步 BR-AI-14。
it.each([
  [47, 'reject'],
  [48, 'throw'],
  [49, 'short'],
  [50, 'long'],
] as const)('[AC-B3-04d#%i] Jev %s 整轮视为未知，不采用错位结论也不重试', async (_id, mode) => {
  const h = fixture('jev');
  const input = [card({ product_key: 'tb:a' }), card({ product_key: 'tb:b', title: '合成12盒' })];
  if (mode === 'reject') h.check.mockRejectedValueOnce(new Error('synthetic-upstream-failure'));
  if (mode === 'throw')
    h.check.mockImplementationOnce(() => {
      throw new Error('synthetic-sync-failure');
    });
  if (mode === 'short') h.check.mockResolvedValueOnce(['consistent']);
  if (mode === 'long') h.check.mockResolvedValueOnce(['consistent', 'consistent', 'consistent']);
  const result = await assignMatchTags(input, { spec: '24盒', relaxed: false }, 'app-a', h.deps);
  expect(labels(result)).toEqual([
    { match_tag: 'spec_unconfirmed', spec_text: null },
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
  expect(result.map((item) => item.product_key)).toEqual(['tb:a', 'tb:b']);
  expect(h.check).toHaveBeenCalledTimes(1);
});

it('[AC-B3-04d#51] 默认 400ms 硬超时：399ms 未完成，400ms 降级，迟到结果不能升级', async () => {
  const h = fixture('jev');
  const late = Promise.withResolvers<Awaited<ReturnType<ResultCheckPort['check']>>>();
  h.check.mockReturnValueOnce(late.promise); // 故意不响应 abort，必须由调用方截止。
  const input = [card(), card({ title: '合成牛奶12盒' })];
  const running = assignMatchTags(input, { spec: '24盒', relaxed: false }, 'app-a', h.deps);
  const observed = observe(running);
  try {
    await flush();
    // 骨架拒绝须原样冒泡，不能因等待端口启动而变成测试超时。
    if (observed.settled === 'rejected') throw observed.error;
    expect(h.check).toHaveBeenCalledTimes(1);
    await h.scheduler.advance(399);
    expect(observed.settled).toBe('pending');
    await h.scheduler.advance(1);
    expect(observed.settled).toBe('resolved');
    const result = await running;
    expect(labels(result)).toEqual([
      { match_tag: 'spec_unconfirmed', spec_text: null },
      { match_tag: 'spec_unconfirmed', spec_text: null },
    ]);
    expect(result.map((item) => item.product_key)).toEqual(input.map((item) => item.product_key));
    expect(h.check.mock.calls[0]?.[2].aborted).toBe(true);
    late.resolve(['consistent', 'consistent']);
    await flush();
    expect(labels(result)).toEqual([
      { match_tag: 'spec_unconfirmed', spec_text: null },
      { match_tag: 'spec_unconfirmed', spec_text: null },
    ]);
    expect(h.check).toHaveBeenCalledTimes(1);
  } finally {
    late.resolve(['consistent', 'consistent']);
  }
});

it('[AC-B3-04d#52] provider 每次按 app_id 读取，前一应用的 Jev 开关不污染后一应用', async () => {
  const h = fixture('jev');
  h.provider.mockImplementation(async (appId) => (appId === 'app-jev' ? 'jev' : 'rules'));
  h.check.mockResolvedValue(['inconsistent']);
  const conditions = { spec: '24盒', relaxed: false };
  const input = [card()];
  expect(labels(await assignMatchTags(input, conditions, 'app-jev', h.deps))).toEqual([
    { match_tag: 'spec_unconfirmed', spec_text: null },
  ]);
  expect(labels(await assignMatchTags(input, conditions, 'app-rules', h.deps))).toEqual([
    { match_tag: 'matched', spec_text: '24盒' },
  ]);
  expect(h.provider.mock.calls).toEqual([['app-jev'], ['app-rules']]);
  expect(h.check).toHaveBeenCalledTimes(1);
});
