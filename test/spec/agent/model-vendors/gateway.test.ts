// BR-AI-14 细则「多厂商接入」：线上 / 离线用途分开（运行时拦截）、离线数据范围、改写样本按接入路径与用途的外发许可、
// 负责人聚合统计的外发批准、离线额度、计量分开；编排决定 G1：取消信号原样转交。
// 期望值一律手写字面量或由 expectedResult 独立新建，不与被测代码拿到的对象共享引用。
import { expect, it } from 'vitest';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  OfflineDataClass,
  OfflineVendorCall,
  OnlineVendorCall,
  OwnerAggregateApproval,
  RewrittenSampleGrant,
  VendorCall,
  VendorId,
  VendorUsage,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import {
  FakeTransport,
  MemorySink,
  expectedResult,
  fixedAt,
  fixedClock,
  rejectionCode,
  syntheticBody,
} from './kit.ts';

interface SetupOptions {
  billable?: boolean;
  budget?: readonly VendorId[];
  grants?: readonly RewrittenSampleGrant[];
  aggregates?: readonly OwnerAggregateApproval[];
  usages?: readonly VendorUsage[];
}

function setup(o: SetupOptions = {}) {
  const transport = new FakeTransport(o.billable ?? true, o.usages);
  const onlineMeter = new MemorySink();
  const offlineMeter = new MemorySink();
  const gateway = createVendorGateway({
    transport,
    clock: fixedClock,
    onlineMeter,
    offlineMeter,
    offlineBudgetApproved: o.budget ?? [],
    rewrittenSampleGrants: o.grants ?? [],
    ownerAggregateApprovals: o.aggregates ?? [],
  });
  return { gateway, transport, onlineMeter, offlineMeter };
}

function onlineQwen(): OnlineVendorCall {
  return {
    purpose: 'online',
    vendor: 'qwen',
    model: 'qwen-synthetic-flash',
    dataClass: 'user_input',
    body: syntheticBody(),
  };
}

function offline(vendor: VendorId, patch: Partial<OfflineVendorCall> = {}): OfflineVendorCall {
  return {
    purpose: 'offline',
    vendor,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-a',
    model: `${vendor}-synthetic-m1`,
    dataClass: 'synthetic',
    body: syntheticBody(),
    ...patch,
  };
}

/** 合成许可：GLM 经百炼、业务空间 A、模型 m1、用途 eval_compare，书面确认不训练 + 法务同意。 */
function glmGrant(patch: Partial<RewrittenSampleGrant> = {}): RewrittenSampleGrant {
  return {
    vendor: 'glm',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-a',
    model: 'glm-synthetic-m1',
    use: 'eval_compare',
    noTrainingConfirmed: true,
    legalApproved: true,
    ...patch,
  };
}

function meterEntry(vendor: VendorId, use: string, model: string, input: number, output: number) {
  return {
    vendor,
    purpose: 'offline',
    use,
    model,
    input_tokens: input,
    output_tokens: output,
    recorded_at: new Date(fixedAt),
  };
}

it('[BR-AI-14 多厂商接入#8] 线上千问调用经传输发出，只记入线上计量（日预算口径），记录时刻取注入时钟', async () => {
  const s = setup();
  const response = await s.gateway.invoke(onlineQwen());
  expect(response).toEqual({
    chunks: [{ synthetic: true, delta: '合成:qwen:qwen-synthetic-flash' }],
    usage: { input_tokens: 120, output_tokens: 30 },
  });
  expect(s.transport.calls).toEqual([
    { vendor: 'qwen', model: 'qwen-synthetic-flash', body: syntheticBody() },
  ]);
  expect(s.onlineMeter.entries).toEqual([
    {
      vendor: 'qwen',
      purpose: 'online',
      use: null,
      model: 'qwen-synthetic-flash',
      input_tokens: 120,
      output_tokens: 30,
      recorded_at: new Date(fixedAt),
    },
  ]);
  expect(s.offlineMeter.entries).toEqual([]);
});

it.each([
  ['glm', 'vendor_not_online'],
  ['deepseek', 'vendor_unknown'],
])(
  '[BR-AI-14 多厂商接入#9] 运行时拦截：%s 进入线上调用被拒（%s），不发请求、不计量',
  async (vendor, code) => {
    const s = setup({ budget: ['glm'] });
    const call = { ...onlineQwen(), vendor } as unknown as VendorCall;
    expect(await rejectionCode(() => s.gateway.invoke(call))).toBe(code);
    expect(s.transport.calls).toEqual([]);
    expect(s.onlineMeter.entries).toEqual([]);
    expect(s.offlineMeter.entries).toEqual([]);
  },
);

it.each<[VendorId, 'user_input' | 'production']>([
  ['qwen', 'user_input'],
  ['qwen', 'production'],
  ['glm', 'user_input'],
  ['glm', 'production'],
])(
  '[BR-AI-14 多厂商接入#10] 离线用途不处理用户输入与生产数据：%s 离线收到 %s 被拒，不发请求',
  async (vendor, dataClass) => {
    const s = setup({ budget: ['glm'] });
    const call = offline(vendor, { dataClass } as unknown as Partial<OfflineVendorCall>);
    expect(await rejectionCode(() => s.gateway.invoke(call))).toBe('data_class_not_allowed');
    expect(s.transport.calls).toEqual([]);
  },
);

it.each<VendorId>(['qwen', 'glm'])(
  '[BR-AI-14 多厂商接入#11] 没有登记外发许可时，%s 离线收到改写样本被拒',
  async (vendor) => {
    const s = setup({ budget: ['glm'] });
    const call = offline(vendor, { dataClass: 'rewritten_sample' });
    expect(await rejectionCode(() => s.gateway.invoke(call))).toBe('rewritten_sample_not_allowed');
    expect(s.transport.calls).toEqual([]);
  },
);

it('[BR-AI-14 多厂商接入#12] 改写样本：与许可的厂商、接入平台、业务空间、模型、用途完全一致才放行', async () => {
  const s = setup({ budget: ['glm'], grants: [glmGrant()] });
  const response = await s.gateway.invoke(offline('glm', { dataClass: 'rewritten_sample' }));
  expect(response).toEqual(expectedResult('glm', 'glm-synthetic-m1'));
  expect(s.transport.calls).toEqual([
    { vendor: 'glm', model: 'glm-synthetic-m1', body: syntheticBody() },
  ]);
});

it.each<[string, Partial<OfflineVendorCall>]>([
  ['接入平台（智谱直连）', { accessPath: 'zhipu_open' }],
  ['业务空间 B', { workspace: 'ws-synthetic-b' }],
  ['模型 m2', { model: 'glm-synthetic-m2' }],
  ['用途 prompt_rewrite', { use: 'prompt_rewrite' }],
])('[BR-AI-14 多厂商接入#13] 改写样本许可不继承：只变%s即拒绝，不调传输', async (_name, patch) => {
  const s = setup({ budget: ['glm'], grants: [glmGrant()] });
  const call = offline('glm', { dataClass: 'rewritten_sample', ...patch });
  expect(await rejectionCode(() => s.gateway.invoke(call))).toBe('rewritten_sample_not_allowed');
  expect(s.transport.calls).toEqual([]);
});

it('[BR-AI-14 多厂商接入#14] 改写样本许可不跨厂商：GLM 的许可不放行同路径同用途的千问', async () => {
  const s = setup({ budget: ['glm'], grants: [glmGrant()] });
  const call = offline('qwen', { dataClass: 'rewritten_sample', model: 'glm-synthetic-m1' });
  expect(await rejectionCode(() => s.gateway.invoke(call))).toBe('rewritten_sample_not_allowed');
  expect(s.transport.calls).toEqual([]);
});

it.each<[string, VendorId, Partial<RewrittenSampleGrant>, string]>([
  ['GLM 未书面确认不训练', 'glm', { noTrainingConfirmed: false }, 'no_training_unconfirmed'],
  ['GLM 已确认不训练但无法务同意', 'glm', { legalApproved: false }, 'legal_approval_missing'],
  ['千问未书面确认不训练', 'qwen', { noTrainingConfirmed: false }, 'no_training_unconfirmed'],
  ['千问已确认、无法务同意（千问不需要）', 'qwen', { legalApproved: false }, 'no_error'],
])(
  '[BR-AI-14 多厂商接入#15] 改写样本：书面确认不训练与千问以外的法务同意分开判断——%s',
  async (_name, vendor, patch, code) => {
    const grant = glmGrant({ vendor, model: `${vendor}-synthetic-m1`, ...patch });
    const s = setup({ budget: ['glm'], grants: [grant] });
    const call = offline(vendor, { dataClass: 'rewritten_sample' });
    expect(await rejectionCode(() => s.gateway.invoke(call))).toBe(code);
    expect(s.transport.calls).toHaveLength(code === 'no_error' ? 1 : 0);
  },
);

it('[BR-AI-14 多厂商接入#16] 负责人聚合统计写成的评测题：千问可用；GLM 只有额度没有批准时拒绝；有批准记录后放行', async () => {
  const qwen = setup();
  await expect(
    qwen.gateway.invoke(offline('qwen', { dataClass: 'owner_aggregate' })),
  ).resolves.toEqual(expectedResult('qwen', 'qwen-synthetic-m1'));

  const budgetOnly = setup({ budget: ['glm'] });
  const call = offline('glm', { dataClass: 'owner_aggregate' });
  expect(await rejectionCode(() => budgetOnly.gateway.invoke(call))).toBe(
    'owner_aggregate_not_approved',
  );
  expect(budgetOnly.transport.calls).toEqual([]);

  const approved = setup({
    budget: ['glm'],
    aggregates: [{ vendor: 'glm', approvalRecord: 'synthetic-approval-001' }],
  });
  await expect(
    approved.gateway.invoke(offline('glm', { dataClass: 'owner_aggregate' })),
  ).resolves.toEqual(expectedResult('glm', 'glm-synthetic-m1'));
  expect(approved.transport.calls).toEqual([
    { vendor: 'glm', model: 'glm-synthetic-m1', body: syntheticBody() },
  ]);
});

it.each<[VendorId, OfflineDataClass]>([
  ['qwen', 'synthetic'],
  ['qwen', 'public_product'],
  ['qwen', 'prompt'],
  ['glm', 'synthetic'],
  ['glm', 'public_product'],
  ['glm', 'prompt'],
])(
  '[BR-AI-14 多厂商接入#17] 离线可处理合成数据、公开商品数据与提示词：%s 离线 %s 到达传输层（GLM 已定额度）',
  async (vendor, dataClass) => {
    const s = setup({ budget: ['glm'] });
    await expect(s.gateway.invoke(offline(vendor, { dataClass }))).resolves.toEqual(
      expectedResult(vendor, `${vendor}-synthetic-m1`),
    );
    expect(s.transport.calls).toEqual([
      { vendor, model: `${vendor}-synthetic-m1`, body: syntheticBody() },
    ]);
  },
);

it('[BR-AI-14 多厂商接入#18] 千问以外厂商在负责人定额度前不发生付费离线调用（06 Q-C31）', async () => {
  const s = setup();
  expect(await rejectionCode(() => s.gateway.invoke(offline('glm')))).toBe('offline_budget_unset');
  expect(s.transport.calls).toEqual([]);
  expect(s.offlineMeter.entries).toEqual([]);
});

it('[BR-AI-14 多厂商接入#19] 未定额度时 GLM 仍可走不计费的录制回放，回放不产生计量', async () => {
  const s = setup({ billable: false });
  await expect(s.gateway.invoke(offline('glm'))).resolves.toEqual(
    expectedResult('glm', 'glm-synthetic-m1'),
  );
  expect(s.transport.calls).toEqual([
    { vendor: 'glm', model: 'glm-synthetic-m1', body: syntheticBody() },
  ]);
  expect(s.onlineMeter.entries).toEqual([]);
  expect(s.offlineMeter.entries).toEqual([]);
});

it('[BR-AI-14 多厂商接入#20] 千问离线不设预算上限：未列入额度清单也放行，且只记离线计量、不进日预算', async () => {
  const s = setup();
  await s.gateway.invoke(offline('qwen', { use: 'review_scoring' }));
  expect(s.onlineMeter.entries).toEqual([]);
  expect(s.offlineMeter.entries).toEqual([
    meterEntry('qwen', 'review_scoring', 'qwen-synthetic-m1', 120, 30),
  ]);
});

it('[BR-AI-14 多厂商接入#21] 离线按厂商独立计量：连续调用的请求、返回与各次用量都落到对应厂商', async () => {
  const s = setup({
    budget: ['glm'],
    usages: [
      { input_tokens: 11, output_tokens: 7 },
      { input_tokens: 23, output_tokens: 5 },
      { input_tokens: 31, output_tokens: 2 },
    ],
  });
  const r1 = await s.gateway.invoke(offline('glm', { use: 'prompt_rewrite' }));
  const r2 = await s.gateway.invoke(offline('qwen', { use: 'synthetic_eval_gen' }));
  const r3 = await s.gateway.invoke(
    offline('glm', { use: 'eval_compare', model: 'glm-synthetic-m2' }),
  );
  expect([r1, r2, r3]).toEqual([
    expectedResult('glm', 'glm-synthetic-m1', 11, 7),
    expectedResult('qwen', 'qwen-synthetic-m1', 23, 5),
    expectedResult('glm', 'glm-synthetic-m2', 31, 2),
  ]);
  expect(s.transport.calls).toEqual([
    { vendor: 'glm', model: 'glm-synthetic-m1', body: syntheticBody() },
    { vendor: 'qwen', model: 'qwen-synthetic-m1', body: syntheticBody() },
    { vendor: 'glm', model: 'glm-synthetic-m2', body: syntheticBody() },
  ]);
  expect(s.offlineMeter.entries).toEqual([
    meterEntry('glm', 'prompt_rewrite', 'glm-synthetic-m1', 11, 7),
    meterEntry('qwen', 'synthetic_eval_gen', 'qwen-synthetic-m1', 23, 5),
    meterEntry('glm', 'eval_compare', 'glm-synthetic-m2', 31, 2),
  ]);
  expect(s.onlineMeter.entries).toEqual([]);
});

it('[BR-AI-14 多厂商接入#22] 不计费传输上的线上调用同样不计量（回放不占日预算）', async () => {
  const s = setup({ billable: false });
  await expect(s.gateway.invoke(onlineQwen())).resolves.toEqual(
    expectedResult('qwen', 'qwen-synthetic-flash'),
  );
  expect(s.transport.calls).toHaveLength(1);
  expect(s.onlineMeter.entries).toEqual([]);
  expect(s.offlineMeter.entries).toEqual([]);
});

it('[BR-AI-14 多厂商接入#23] 换厂商不改变模型可见内容：请求体按调用方原样交给传输，不按厂商改写，也不改动调用方对象', async () => {
  const s = setup({ budget: ['glm'] });
  const glmCall = offline('glm');
  const qwenCall = offline('qwen');
  await s.gateway.invoke(glmCall);
  await s.gateway.invoke(qwenCall);
  expect(s.transport.calls.map((c) => c.body)).toEqual([syntheticBody(), syntheticBody()]);
  expect([glmCall.body, qwenCall.body]).toEqual([syntheticBody(), syntheticBody()]);
});

it('[编排决定 G1#1] 调用时传入的取消信号原样（同一对象）交给传输', async () => {
  const s = setup({ budget: ['glm'] });
  const controller = new AbortController();
  await s.gateway.invoke(onlineQwen(), controller.signal);
  await s.gateway.invoke(offline('glm'), controller.signal);
  expect(s.transport.signals).toHaveLength(2);
  for (const signal of s.transport.signals) expect(signal).toBe(controller.signal);
});

it('[编排决定 G1#2] 调用前已取消的信号：不调传输、不计量，以 aborted 结束', async () => {
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  expect(await rejectionCode(() => s.gateway.invoke(onlineQwen(), controller.signal))).toBe(
    'aborted',
  );
  expect(s.transport.calls).toEqual([]);
  expect(s.onlineMeter.entries).toEqual([]);
});
