import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { claimDraftCard } from '../../../../apps/api/src/modules/agent/tools/claim/index.ts';
import {
  context,
  draftOf,
  expectCard,
  fixture,
  ORDER_NO,
  registryContext,
  rejected,
  setup,
} from './kit.ts';

it('[AC-B3-08d#1][BR-AI-03] 只声明必填 platform 与 order_no，平台枚举来自依赖', async () => {
  const f = setup({ platforms: ['jd', 'pdd'] });
  const ctx = registryContext(context());
  expect(f.handler.name).toBe('prefill_claim');
  expect(f.handler.audience).toBe('phone_bound');
  const definitions = await f.registry.definitions(ctx.subject.appId, ctx.subject);
  expect(definitions).toHaveLength(1);
  expect(definitions[0]?.parameters).toMatchObject({
    type: 'object',
    additionalProperties: false,
    properties: {
      platform: { type: 'string', enum: ['jd', 'pdd'] },
      order_no: { type: 'string', minLength: 1, maxLength: 64 },
    },
  });
  const schema = definitions[0]?.parameters as Record<string, unknown>;
  expect([...(schema['required'] as string[])].sort()).toEqual(['order_no', 'platform']);
  expect(Object.keys(schema['properties'] as object).sort()).toEqual(['order_no', 'platform']);
  expect(await f.execute({ platform: 'taobao', order_no: ORDER_NO })).toEqual(rejected);
  expect(f.read).not.toHaveBeenCalled();
});

it.each(['user_id', 'app_id', 'adzoneId', 'sub_unionid', 'pId'])(
  '[AC-B3-08d#1][BR-AI-03] 身份字段 %s 整次拒绝并告警，不丢字段继续执行',
  async (field) => {
    const f = setup();
    expect(
      await f.execute({ platform: 'jd', order_no: ORDER_NO, [field]: 'synthetic-forged' }),
    ).toEqual(rejected);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent.identity_arg', tool: 'prefill_claim' }),
      'agent.identity_arg',
    );
  },
);

it.each([
  {},
  { platform: 'jd' },
  { order_no: ORDER_NO },
  { platform: 'unknown', order_no: ORDER_NO },
  { platform: 'jd', order_no: '' },
  { platform: 'jd', order_no: '9'.repeat(65) },
  { platform: 'jd', order_no: 990000000001 },
  { platform: 'jd', order_no: ORDER_NO, paid_date: '2026-10-23' },
  { platform: 'jd', order_no: ORDER_NO, color: 'red' },
])('[AC-B3-08d#1][BR-AI-03] 缺参、格式错误与普通多余字段拒绝且不告警 %#', async (args) => {
  const f = setup();
  expect(await f.execute(args)).toEqual(rejected);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.warn).not.toHaveBeenCalled();
});

it.each(['9', '9'.repeat(64)])(
  '[AC-B3-08d#1][BR-AI-03] 单号长度边界合法时只作回显 %#',
  async (orderNo) => {
    const f = setup();
    expect(draftOf(await f.execute({ platform: 'jd', order_no: orderNo }))['order_no']).toBe(
      orderNo,
    );
  },
);

it.each([
  { userId: null, phoneBound: false },
  { userId: 'synthetic-unbound', phoneBound: false },
  { userId: null, phoneBound: true },
])('[AC-B3-08d#2][BR-AI-01] 无已绑手机用户主体时不下发且强行执行也拒绝 %#', async (patch) => {
  const f = setup();
  const ctx = context(patch);
  const caller = registryContext(ctx).subject;
  expect(await f.registry.definitions(caller.appId, caller)).toEqual([]);
  expect(await f.execute({ platform: 'jd', order_no: ORDER_NO }, ctx)).toEqual(rejected);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B3-08d#3][BR-AI-03][BR-AI-14] 本 run 占位符还原后去空格，保留前导零与 pdd 连字符', async () => {
  const f = setup();
  const placeholders = Object.freeze({ '<num_1>': ' 0099 0000-0001 ' });
  const outcome = await f.execute(
    { platform: 'pdd', order_no: '<num_1>' },
    context({ placeholders }),
  );
  expect(draftOf(outcome)).toMatchObject({ platform: 'pdd', order_no: '00990000-0001' });
  expect(placeholders['<num_1>']).toBe(' 0099 0000-0001 ');
  expect(outcome.modelView).toEqual({});
});

it.each<{ value: string; placeholders: Readonly<Record<string, string>> }>([
  { value: '<num_9>', placeholders: {} },
  { value: '<num_1>', placeholders: { '<num_1>': '   ' } },
  { value: '   ', placeholders: {} },
])(
  '[AC-B3-08d#3][BR-AI-03][BR-AI-14] 未知占位符或去空格后为空时拒绝，不读点击记录 %#',
  async ({ value, placeholders }) => {
    const f = setup();
    expect(await f.execute({ platform: 'jd', order_no: value }, context({ placeholders }))).toEqual(
      rejected,
    );
    expect(f.read).not.toHaveBeenCalled();
  },
);

it('[AC-B3-08d#3][BR-AI-03][BR-AI-14] 同名占位符只用当前 run 的表，不能串用上一 run', async () => {
  const f = setup();
  for (const [runId, raw] of [
    ['synthetic-run-a', '990000000001'],
    ['synthetic-run-b', '990000000002'],
  ] as const) {
    const outcome = await f.execute(
      { platform: 'jd', order_no: '<num_1>' },
      context({ runId, placeholders: { '<num_1>': raw } }),
    );
    expect(draftOf(outcome)['order_no']).toBe(raw);
  }
  expect(
    await f.execute({ platform: 'jd', order_no: '<num_1>' }, context({ runId: 'synthetic-run-c' })),
  ).toEqual(rejected);
  expect(f.read).toHaveBeenCalledTimes(2);
});

it('[AC-B3-08d#4][BR-AI-01] 只出可提交的草稿卡，不预填 paid_date 或证据结论，符合真实契约', async () => {
  const f = setup();
  expect(draftOf(await f.execute({ platform: 'jd', order_no: ' 9900 0000 0001 ' }))).toEqual({
    platform: 'jd',
    order_no: ORDER_NO,
    click_times: [],
    evidence_summary: null,
    // 任务书 §9 的默认文案键；字典补齐由文案任务负责。
    submit_action: { text_key: 'agent.card.claim_draft.submit', action: 'submit_claim' },
  });
});

it('[AC-B3-08d#4][BR-AI-01] 导出出卡函数可独立复用，同一输入生成相同草稿', async () => {
  const f = fixture();
  const ctx = context();
  const card = await claimDraftCard(f.deps, ctx, { platform: 'jd', orderNo: ORDER_NO });
  expect(expectCard(card)).toEqual({
    platform: 'jd',
    order_no: ORDER_NO,
    click_times: [],
    evidence_summary: null,
    submit_action: { text_key: 'agent.card.claim_draft.submit', action: 'submit_claim' },
  });
  const handler = setup();
  expect(draftOf(await handler.execute())).toEqual(card.data);
});

it.each([false, true])(
  '[AC-B3-08d#6][BR-AI-01] 任意单号均只回显，模型只拿卡引用（启用引用=%s）',
  async (withReference) => {
    const cardReference = vi.fn(() => 'synthetic-card-reference');
    const f = setup(withReference ? { cardReference } : {});
    // 无订单读口、无未归因池、无真实订单存在性信息；期望视图不能由待测函数计算。
    for (const orderNo of ['990000000001', '990000000099', '000000000000']) {
      const outcome = await f.execute({ platform: 'jd', order_no: orderNo });
      expect(draftOf(outcome)['order_no']).toBe(orderNo);
      expect(outcome.modelView).toEqual(
        withReference ? { card_id: 'synthetic-card-reference' } : {},
      );
      expect(JSON.stringify(outcome.modelView)).not.toContain(orderNo);
    }
    if (withReference) {
      expect(cardReference).toHaveBeenCalledTimes(3);
      expect(cardReference).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'synthetic-app',
          userId: 'synthetic-user',
          runId: 'synthetic-run',
        }),
        0,
      );
    } else {
      expect(cardReference).not.toHaveBeenCalled();
    }
  },
);

it('[AC-B3-08d#6][AC-B3-08d#7][BR-AI-01][BR-AI-02] 出卡路径不引入订单查询、认领写入或外跳执行函数', async () => {
  // 先验证可用的只读出卡入口，保证骨架期此静态规则也确实先红。
  const f = setup();
  expect(draftOf(await f.execute())['evidence_summary']).toBeNull();
  const root = new URL('../../../../apps/api/src/modules/agent/tools/claim/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(new URL(file, root), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      // AST 避免把注释中说明“禁止调用”的函数名当作实际引用。
      if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
        expect(['createOrderClaimIn', 'createOrderClaim', 'openLink'], file).not.toContain(
          node.text,
        );
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) return;
        const module = node.moduleSpecifier.text;
        // 不得绕过只读端口自行查订单、未归因池或直接写库；纯类型导入不算读写。
        expect(module, file).not.toMatch(/^(?:@couli\/db|kysely|pg)(?:\/|$)/u);
        if (/(?:^|\/)orders(?:\/|$)/u.test(module)) {
          expect(clause?.name, file).toBeUndefined();
          const bindings = clause?.namedBindings;
          expect(bindings !== undefined && ts.isNamedImports(bindings), file).toBe(true);
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const item of bindings.elements) {
              if (!item.isTypeOnly) {
                expect(
                  ['stripClaimSpaces', 'claimCompareValue', 'claimWindowHours'],
                  file,
                ).toContain((item.propertyName ?? item.name).text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});

it('[AC-B3-08d#8][BR-AI-01] 点击记录读取失败返回 failed，不生成卡引用或半张卡', async () => {
  const cardReference = vi.fn(() => 'synthetic-card-reference');
  const f = setup({ cardReference });
  f.read.mockRejectedValue(new Error('synthetic-private-reader-error'));
  const outcome = await f.execute();
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({ kind: 'failed', modelView: { error: 'tool_failed' } });
  expect(outcome).not.toHaveProperty('cards');
  expect(cardReference).not.toHaveBeenCalled();
});
