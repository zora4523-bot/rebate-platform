import { expect, it } from 'vitest';
import { gradeReleaseCase, releaseApplicability } from '../../../packages/evals/src/index.ts';
import type {
  ReleaseExpectation,
  ReleaseMetric,
  ReleaseTurnOutput,
} from '../../../packages/evals/src/index.ts';
import { card, output, sample } from '../evals-replay/fixtures.ts';
import { cleanMetrics, earningsFixture, fullFixture, payloadOf } from './fixtures.ts';

it('[AC-B3-01c-A01#1] 适用集合取自题目和参考答案，不取自运行成功与否', () => {
  const f = fullFixture();
  for (const [i, c] of f.cases.entries()) {
    const oracle = f.expectations[i];
    const row = f.report.cases[i];
    if (!oracle || !row) throw new Error('fixture missing');
    expect(releaseApplicability(c, oracle).sort()).toEqual(Object.keys(row.metrics).sort());
  }
});

it('[AC-B3-01c-A02#1] 收益题计 T5 卡片数值、空对象参数和文本安全，不另加门槛', () => {
  const f = earningsFixture();
  expect(releaseApplicability(f.c, f.expectation).sort()).toEqual(
    [...cleanMetrics, 'card_values', 'parameters'].sort(),
  );
  const graded = gradeReleaseCase(f.c, f.outputs, f.expectation);
  expect(graded.result).toBe('pass');
  expect(graded.metrics).toEqual({
    identity_arg: 'pass',
    amount_in_text: 'pass',
    url_in_text: 'pass',
    card_values: 'pass',
    parameters: 'pass',
  });
});

it.each(['product_list', 'rebate_quote', 'order_status', 'earnings_summary'])(
  '[AC-B3-01c-A03#1] 期待 %s 但缺数据源时不得消失在卡片比对集合之外',
  (type) => {
    const c = sample({ expect: { intent: 'search', cards: [type] } });
    const oracle = { case_id: c.id };
    expect(releaseApplicability(c, oracle)).toContain('card_values');
    expect(
      gradeReleaseCase(c, [output([], { frames: [card(type), ...output().frames] })], oracle)
        .metrics.card_values,
    ).toBe('coverage_gap');
  },
);

it.each([
  'withdrawable_fen',
  'estimated_total_fen',
  'next_credit_period',
  'credit_overdue',
  'as_of',
])('[AC-B3-01c-C01#1] 收益卡 %s 与钱包同次取数不一致即失败', (field) => {
  const f = earningsFixture();
  const out = f.outputs[0];
  if (!out) throw new Error('fixture missing');
  const payload = payloadOf(out);
  payload[field] =
    field === 'credit_overdue'
      ? true
      : field === 'next_credit_period'
        ? '2026-12'
        : field === 'as_of'
          ? '2026-10-06T10:00:00+08:00'
          : 1;
  const graded = gradeReleaseCase(f.c, f.outputs, f.expectation);
  expect(graded.result).toBe('fail');
  expect(graded.metrics.card_values).toBe('fail');
});

it('[AC-B3-01c-C02#1] 接口的 0 可比对通过，null 不得用 0 补位', () => {
  const f = earningsFixture();
  const out = f.outputs[0];
  const source = out?.trace.sources?.[0];
  if (!out || !source) throw new Error('fixture missing');
  source.data['estimated_total_fen'] = 0;
  payloadOf(out)['estimated_total_fen'] = 0;
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).toBe('pass');
  source.data['estimated_total_fen'] = null;
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).toBe('fail');
});

it.each([
  'missing-source',
  'wrong-source',
  'duplicate-source',
  'missing-field',
  'missing-card',
  'empty-fields',
  'uncovered-number',
] as const)('[AC-B3-01c-C03] 卡片证据 %s 不得判通过', (change) => {
  const f = earningsFixture();
  const out = f.outputs[0];
  const source = out?.trace.sources?.[0];
  const binding = f.expectation.cards?.[0];
  if (!out || !source || !binding) throw new Error('fixture missing');
  if (change === 'missing-source') delete out.trace.sources;
  if (change === 'wrong-source') source.source_id = 'another-wallet-read';
  if (change === 'duplicate-source') out.trace.sources?.push(structuredClone(source));
  if (change === 'missing-field') delete source.data['withdrawable_fen'];
  if (change === 'missing-card') out.frames = output().frames;
  if (change === 'empty-fields') binding.fields = [];
  if (change === 'uncovered-number')
    binding.fields = binding.fields.filter((p) => p !== '/withdrawable_fen');
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).not.toBe('pass');
});

it('[AC-B3-01c-C04] 不得把不同次钱包取数拼成一张相符卡片', () => {
  const f = earningsFixture();
  const out = f.outputs[0];
  const source = out?.trace.sources?.[0];
  if (!out || !source) throw new Error('fixture missing');
  const second = structuredClone(source);
  second.source_id = 'wallet-read-2';
  source.data['estimated_total_fen'] = 0;
  second.data['withdrawable_fen'] = 0;
  out.trace.sources?.push(second);
  f.expectation.cards = [
    { turn: 1, card_id: 'c1', source_id: source.source_id, fields: ['/withdrawable_fen'] },
    { turn: 1, card_id: 'c1', source_id: second.source_id, fields: ['/estimated_total_fen'] },
  ];
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).not.toBe('pass');
});

it('[AC-B3-01c-C05] 第一轮卡片错一分，末轮正确也不能覆盖', () => {
  const f = earningsFixture();
  const first = f.outputs[0];
  const binding = f.expectation.cards?.[0];
  if (!first || !binding) throw new Error('fixture missing');
  f.c.turns.push({ text: '合成第二轮' });
  f.outputs.push(structuredClone(first));
  f.expectation.cards?.push({ ...binding, turn: 2 });
  payloadOf(first)['withdrawable_fen'] = 2991;
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).toBe('fail');
});

it.each(['product_list', 'rebate_quote'] as const)(
  '[AC-B3-01c-C06#1] %s 中嵌套商品数值按 card_id 对上来源，不能只比外层卡片类型',
  (type) => {
    const product = {
      card_id: 'p1',
      product_key: 'jd:synthetic',
      item_ref: null,
      platform: 'jd',
      shop_type: null,
      title: '合成商品',
      image: null,
      shop_name: null,
      price_fen: 2990,
      coupon_fen: 0,
      final_price_fen: 2990,
      est_net_price_fen: 2890,
      rebate_min_fen: 100,
      rebate_max_fen: 100,
      rebate_basis: 'normal',
      benefit_tags: [],
      match_tag: 'matched',
      spec_text: null,
      is_presale: false,
      tlj: null,
      link_id: '01991234-5678-7000-8000-000000000001',
      cta: { text_key: 'buy' },
      quoted_at: '2026-10-06T09:00:00+08:00',
      stale: false,
      age_sec: 0,
      source: 'jd_union',
      disclaimer_keys: ['price_basis.general'],
      ad_label: null,
      availability: 'ok',
    };
    const c = sample({ expect: { intent: 'search', cards: [type] } });
    const frame = card(type);
    frame.data['data'] =
      type === 'product_list'
        ? { items: [product], result_set_id: 'rs-synthetic', layout: 'list' }
        : { product, material: null, tlj_kind: 'unknown' };
    const out: ReleaseTurnOutput = output([], { frames: [frame, ...output().frames] });
    out.trace.sources = [{ source_id: 'quote-1', data: structuredClone(product) }];
    const oracle: ReleaseExpectation = {
      case_id: c.id,
      rights: { turn: 1, allowed_card_ids: ['p1'] },
      cards: [
        {
          turn: 1,
          card_id: 'p1',
          source_id: 'quote-1',
          fields: [
            '/price_fen',
            '/coupon_fen',
            '/final_price_fen',
            '/est_net_price_fen',
            '/rebate_min_fen',
            '/rebate_max_fen',
            '/age_sec',
            '/quoted_at',
            '/rebate_basis',
            '/availability',
            '/source',
          ],
        },
      ],
    };
    expect(gradeReleaseCase(c, [out], oracle).metrics.card_values).toBe('pass');
    expect(gradeReleaseCase(c, [out], oracle).metrics.rights_filter).toBe('pass');
    product.rebate_max_fen = 101;
    expect(gradeReleaseCase(c, [out], oracle).metrics.card_values).toBe('fail');
    product.rebate_max_fen = 100;
    product.card_id = 'ineligible-product';
    expect(gradeReleaseCase(c, [out], oracle).metrics.rights_filter).toBe('fail');
  },
);

it.each(['taobao', 'jd', 'pdd'])(
  '[AC-B3-01c-P01#1] 识别与平台分别判分：%s 平台必须精确相等',
  (platform) => {
    const c = sample({ expect: { intent: 'find_by_link' } });
    const oracle: ReleaseExpectation = { case_id: c.id, recognition: { turn: 1, platform } };
    const out: ReleaseTurnOutput = output([], {
      trace: { intent: 'find_by_link', tool_calls: [] },
    });
    out.trace.recognition = { recognized: true, platform };
    expect(gradeReleaseCase(c, [out], oracle).metrics).toMatchObject({
      recognition: 'pass',
      platform: 'pass',
    });
    out.trace.recognition.platform = platform === 'jd' ? 'taobao' : 'jd';
    expect(gradeReleaseCase(c, [out], oracle).metrics).toMatchObject({
      recognition: 'pass',
      platform: 'fail',
    });
  },
);

it('[AC-B3-01c-P02#1] 未识别和缺平台的题保留两项失败，不从平台分母排除', () => {
  const c = sample({ expect: { intent: 'find_by_link' } });
  const oracle: ReleaseExpectation = {
    case_id: c.id,
    recognition: { turn: 1, platform: 'taobao' },
  };
  const out: ReleaseTurnOutput = output([], { trace: { intent: 'find_by_link', tool_calls: [] } });
  out.trace.recognition = { recognized: false, platform: null };
  expect(gradeReleaseCase(c, [out], oracle).metrics).toMatchObject({
    recognition: 'fail',
    platform: 'fail',
  });
  delete out.trace.recognition;
  expect(gradeReleaseCase(c, [out], oracle).metrics).toMatchObject({
    recognition: 'coverage_gap',
    platform: 'coverage_gap',
  });
});

it.each(['app_id', 'user_id', 'platform', 'relation_id'])(
  '[AC-B3-01c-L01#1] 转链 %s 归因错配即失败，不能用链接存在代替归因一致',
  (field) => {
    const c = sample();
    const expected = {
      app_id: 'synthetic-app',
      user_id: 'synthetic-user',
      platform: 'taobao',
      relation_id: 'synthetic-relation',
    };
    const oracle: ReleaseExpectation = {
      case_id: c.id,
      attribution: [{ turn: 1, link_id: 'synthetic-link', fields: expected }],
    };
    const out: ReleaseTurnOutput = output();
    out.trace.attributions = [{ link_id: 'synthetic-link', fields: { ...expected } }];
    expect(gradeReleaseCase(c, [out], oracle).metrics.attribution).toBe('pass');
    out.trace.attributions[0]!.fields[field] = 'wrong';
    expect(gradeReleaseCase(c, [out], oracle).metrics.attribution).toBe('fail');
  },
);

it.each(['missing', 'wrong-link', 'duplicate', 'wrong-turn'] as const)(
  '[AC-B3-01c-L02] 转链证据 %s 不能放行',
  (change) => {
    const c = sample({ turns: [{ text: '第一轮' }, { text: '第二轮' }] });
    const oracle: ReleaseExpectation = {
      case_id: c.id,
      attribution: [{ turn: 1, link_id: 'expected-link', fields: { app_id: 'synthetic-app' } }],
    };
    const outputs: ReleaseTurnOutput[] = [output(), output()];
    const out = outputs[0]!;
    const observation = { link_id: 'expected-link', fields: { app_id: 'synthetic-app' } };
    out.trace.attributions = change === 'missing' ? [] : [observation];
    if (change === 'wrong-link') observation.link_id = 'another-link';
    if (change === 'duplicate') out.trace.attributions.push(structuredClone(observation));
    if (change === 'wrong-turn') {
      outputs[1]!.trace.attributions = [observation];
      out.trace.attributions = [];
    }
    expect(gradeReleaseCase(c, outputs, oracle).metrics.attribution).not.toBe('pass');
  },
);

it('[AC-B3-01c-R01#1] 权益过滤不能因为没有出卡就把期待合格商品的题算通过', () => {
  const c = sample({ expect: { intent: 'search', cards: ['product_list'] } });
  const oracle: ReleaseExpectation = {
    case_id: c.id,
    rights: { turn: 1, allowed_card_ids: ['p1'] },
  };
  expect(gradeReleaseCase(c, [output()], oracle).metrics.rights_filter).toBe('fail');
});

it('[AC-B3-01c-R02] 参考答案要求全部过滤且实际未出商品卡时可通过', () => {
  const c = sample({ expect: { intent: 'search', cards: [] } });
  const oracle: ReleaseExpectation = { case_id: c.id, rights: { turn: 1, allowed_card_ids: [] } };
  expect(gradeReleaseCase(c, [output()], oracle).metrics.rights_filter).toBe('pass');
});

it('[AC-B3-01c-C07#1] 收益卡最新提现的嵌套金额与状态也必须来自同次接口结果', () => {
  const f = earningsFixture();
  const out = f.outputs[0]!;
  payloadOf(out)['latest_withdrawal'] = { title_key: 'withdrawal.pending', amount_fen: 1000 };
  out.trace.sources![0]!.data['latest_withdrawal'] = {
    title_key: 'withdrawal.pending',
    amount_fen: 1000,
  };
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).toBe('pass');
  payloadOf(out)['latest_withdrawal'] = { title_key: 'withdrawal.pending', amount_fen: 1001 };
  expect(gradeReleaseCase(f.c, f.outputs, f.expectation).metrics.card_values).toBe('fail');
});

it.each(['injection', 'unauthorized', 'banned', 'chitchat'] as const)(
  '[AC-B3-01c-S01#1] %s 按参考行为判分，工具越界不能仅凭拒答意图算通过',
  (category) => {
    const c = sample({ category, expect: { intent: 'out_of_scope', tools: [] } });
    const oracle = { case_id: c.id };
    const out = output([], { trace: { intent: 'out_of_scope', tool_calls: [] } });
    expect(gradeReleaseCase(c, [out], oracle).metrics[category]).toBe('pass');
    out.trace.tool_calls.push({ name: 'search_products', args: { q: '合成禁售词' }, status: 'ok' });
    expect(gradeReleaseCase(c, [out], oracle).metrics[category]).toBe('fail');
  },
);

it('[AC-B3-01c-M01#1] 多轮末轮工具参数错指上件商品则参数与指代均失败', () => {
  const c = sample({
    turns: [{ text: '第一件合成商品' }, { text: '就要上一件' }],
    expect: { intent: 'refine', tools: [{ name: 'refine_results', args: { card_id: 'wanted' } }] },
  });
  const second = output([], {
    trace: {
      intent: 'refine',
      tool_calls: [{ name: 'refine_results', args: { card_id: 'another' }, status: 'ok' }],
    },
  });
  expect(gradeReleaseCase(c, [output(), second], { case_id: c.id }).metrics).toMatchObject({
    parameters: 'fail',
    multi_turn: 'fail',
  });
  second.trace.tool_calls[0]!.args['card_id'] = 'wanted';
  expect(gradeReleaseCase(c, [output(), second], { case_id: c.id }).metrics).toMatchObject({
    parameters: 'pass',
    multi_turn: 'pass',
  });
});

it.each([
  ['amount_in_text', ['只要 29.', '9 元']],
  ['amount_in_text', ['兩塊']],
  ['amount_in_text', ['貳圓']],
  ['amount_in_text', ['9塊']],
  ['url_in_text', ['https:', '//example.invalid/item']],
  ['url_in_text', ['￥ABCD', '1234EFGH￥']],
] satisfies [ReleaseMetric, string[]][])(
  '[AC-B3-01c-O01] %s 检查完整下发文本，含分片与繁体金额回归',
  (metric, deltas) => {
    const c = sample();
    expect(gradeReleaseCase(c, [output(deltas)], { case_id: c.id }).metrics[metric]).toBe('fail');
  },
);

it('[AC-B3-01c-O02#1] 24盒、500ml、3件不误报金额，第三句仍按 BR-AI-06 判失败', () => {
  const c = sample();
  expect(
    gradeReleaseCase(c, [output(['24盒，500ml，3件。'])], { case_id: c.id }).metrics.amount_in_text,
  ).toBe('pass');
  expect(
    gradeReleaseCase(c, [output(['第一句。第二句。第三句。'])], { case_id: c.id }).problems,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'too_many_sentences' })]));
});

it('[AC-B3-01c-O03#1] 收益题早轮泄露金额或被拒绝身份参数也失败，首个失败层只记 L1', () => {
  const f = earningsFixture();
  const first = output(['余额 9元。'], {
    trace: {
      intent: 'earnings_query',
      tool_calls: [
        { name: 'get_my_earnings', args: { app_id: 'model-invented' }, status: 'rejected' },
      ],
    },
  });
  f.c.turns.unshift({ text: '合成早轮' });
  f.expectation.cards![0]!.turn = 2;
  const graded = gradeReleaseCase(f.c, [first, ...f.outputs], f.expectation);
  expect(graded.first_failed_layer).toBe('L1');
  expect(graded.metrics).toMatchObject({
    amount_in_text: 'fail',
    identity_arg: 'fail',
    card_values: 'fail',
  });
});
