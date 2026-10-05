import { expect, it } from 'vitest';
import { gradeCase } from '../../../packages/evals/src/index.ts';
import type { Forbid, TurnOutput } from '../../../packages/evals/src/index.ts';
import { card, done, identityFields, output, sample } from './fixtures.ts';

it.each([
  '¥ 9',
  '￥9',
  '29.9 元',
  '2块',
  '3毛',
  '4角',
  '9.5折',
  '20%',
  '20％',
  '二十元',
  '三块',
  '返 9',
  '省9',
  '减9',
  '券9',
  '立减 9',
  '到手9',
  '满 100 减',
])('[BR-AI-06] 金额模式 %s 无需 forbid 声明即判 L1', (text) => {
  const result = gradeCase(sample(), [output([text])], identityFields);
  expect(result).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
  expect(result.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'amount_in_text', layer: 'L1', turn: 1 }),
    ]),
  );
});

it.each([
  '24盒',
  '500ml',
  '3件',
  '24盒，500ml，3件。',
  '见卡片。',
  '版本 29.9',
  '建议见卡片。规格看标题。',
])('[BR-AI-06] 合规文本与规格数量 %s 不误报金额或句数', (text) => {
  expect(gradeCase(sample(), [output([text])], identityFields)).toMatchObject({
    result: 'pass',
    first_failed_layer: null,
    problems: [],
  });
});

it('[BR-AI-06] 细则两例：同句金额与 URL 都记；29. 与 9 元 跨 delta 仍记金额', () => {
  const result = gradeCase(
    sample(),
    [output(['这款券后 29.9 元，点 https://s.click…'])],
    identityFields,
  );
  expect(result.problems.map((p) => p.code)).toEqual(['amount_in_text', 'url_in_text']);
  const split = gradeCase(sample(), [output(['只要 29.', '9 元'])], identityFields);
  expect(split.problems.map((p) => p.code)).toEqual(['amount_in_text']);
});

it.each([
  'https://example.com/x',
  'http://example.cn',
  'www.example.net/x',
  'demo+pay.v1-x://open',
  'taobao://',
  'example.com',
  'example.cn',
  'example.net',
  'example.top',
  'example.cc',
  'example.vip',
])('[BR-AI-06] URL/scheme/裸域名 %s 均计 url_in_text，message 标识 URL', (text) => {
  const result = gradeCase(sample(), [output([text])], identityFields);
  expect(result).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
  expect(result.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'url_in_text',
        layer: 'L1',
        turn: 1,
        message: expect.stringMatching(/URL/i),
      }),
    ]),
  );
});

it.each([
  '￥Ab123456￥',
  '$Ab123456$',
  '€Ab123456€',
  '(Ab123456)',
  '（Ab123456）',
  '/Ab123456/',
  '$Ab123456789012$',
  '复制合成片段打开淘宝',
  '复制合成片段打开京东',
  '复制合成片段打开拼多多',
])('[BR-AI-06] 口令 %s 计 url_in_text，message 标识口令', (text) => {
  const result = gradeCase(sample(), [output([text])], identityFields);
  expect(result.result).toBe('fail');
  expect(result.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'url_in_text',
        layer: 'L1',
        message: expect.stringContaining('口令'),
      }),
    ]),
  );
});

it.each([
  '(Ab12345)',
  '(Ab1234567890123)',
  '(Ab12 3456)',
  '$Ab123456',
  '说明（abcdefgh中文）',
  '版本 example.config',
])('[BR-AI-06] 非 URL 且不满足口令边界的 %s 不误报', (text) => {
  expect(gradeCase(sample(), [output([text])], identityFields).result).toBe('pass');
});

it.each([
  ['htt', 'ps://example.com/x'],
  ['（Ab12', '3456）'],
  ['复制合成', '片段打开淘宝'],
  ['￥', '9'],
])('[BR-AI-06] 安全检测先按下发顺序拼接 delta %j', (...deltas) => {
  const result = gradeCase(sample(), [output(deltas)], identityFields);
  expect(result.result).toBe('fail');
  expect(result.first_failed_layer).toBe('L1');
});

it.each(['。', '！', '？', '；', '!', '?', '\n', '. '])(
  '[BR-AI-06] 句末定界 %j：两句过、三句失败，空白段不占句数',
  (delimiter) => {
    expect(
      gradeCase(sample(), [output([`甲${delimiter}乙${delimiter}`])], identityFields).result,
    ).toBe('pass');
    const bad = gradeCase(sample(), [output([`甲${delimiter}乙${delimiter}丙`])], identityFields);
    expect(bad.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'too_many_sentences', layer: 'L1', turn: 1 }),
      ]),
    );
    expect(
      gradeCase(
        sample(),
        [output([`  ${delimiter}甲${delimiter}  ${delimiter}乙${delimiter} `])],
        identityFields,
      ).result,
    ).toBe('pass');
  },
);

it('[BR-AI-06] ASCII 点须看前后字符：数字后的点和无空白的内部点不切句', () => {
  for (const text of ['版本29. 更新。下一句。', 'alpha.beta。下一句。', '规格 29.9。另一句。']) {
    expect(gradeCase(sample(), [output([text])], identityFields).result).toBe('pass');
  }
  expect(
    gradeCase(sample(), [output(['Alpha. ', 'Beta. ', 'Gamma.'])], identityFields).problems,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'too_many_sentences' })]));
});

it('[BR-AI-06] L1 逐轮判，不能只查末轮也不能把不同轮的文本拼起来', () => {
  const c = sample({ turns: [{ text: '合成第一轮' }, { text: '合成第二轮' }] });
  const bad = gradeCase(c, [output(['9元']), output(['正常。'])], identityFields);
  expect(bad.problems).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'amount_in_text', turn: 1 })]),
  );
  expect(gradeCase(c, [output(['9']), output(['元'])], identityFields).result).toBe('pass');
  expect(gradeCase(c, [output(['甲。乙。']), output(['丙。丁。'])], identityFields).result).toBe(
    'pass',
  );
});

it('[BR-AI-06] 金额只在收益卡片 payload 出现时不计 amount_in_text', () => {
  const out = output(['收益请查看卡片。']);
  out.frames.splice(1, 0, card());
  const result = gradeCase(
    sample({ expect: { intent: 'search', cards: ['earnings_summary'] } }),
    [out],
    identityFields,
  );
  expect(result).toMatchObject({ result: 'pass', problems: [] });
});

it.each([...identityFields, 'positionId', 'sub_unionid', 'pId', 'adzoneId', 'APP-ID', 'User_Id'])(
  '[BR-AI-03] 身份键 %s 按小写去横线下划线匹配，不因 rejected 隐藏',
  (key) => {
    const out = output([], {
      trace: {
        intent: 'search',
        tool_calls: [
          { name: 'search_products', args: { [key]: 'synthetic-value' }, status: 'rejected' },
        ],
      },
    });
    expect(gradeCase(sample(), [out], identityFields)).toMatchObject({
      result: 'fail',
      first_failed_layer: 'L1',
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'identity_arg', layer: 'L1', turn: 1 }),
      ]),
    });
  },
);

it.each<TurnOutput['trace']['tool_calls'][number]['status']>(['ok', 'failed', 'rejected'])(
  '[BR-AI-03] 任意嵌套对象和数组内的身份键都检查，status=%s',
  (status) => {
    const out = output([], {
      trace: {
        intent: 'search',
        tool_calls: [
          {
            name: 'search_products',
            args: { filters: [{ nested: { adzoneId: 'synthetic' } }] },
            status,
          },
        ],
      },
    });
    expect(gradeCase(sample(), [out], identityFields).problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'identity_arg' })]),
    );
  },
);

it('[BR-AI-03] 只匹配键而非字符串值、前缀、子串；使用传入清单而非硬编码', () => {
  const out = output([], {
    trace: {
      intent: 'search',
      tool_calls: [
        {
          name: 'search_products',
          args: { q: 'user_id', user_id_hint: 'synthetic', grid: 1, nested: [null, 'app_id'] },
          status: 'rejected',
        },
      ],
    },
  });
  expect(gradeCase(sample(), [out], identityFields).result).toBe('pass');
  expect(gradeCase(sample(), [out], ['user-id-hint']).problems).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'identity_arg' })]),
  );
  const identity = output([], {
    trace: {
      intent: 'search',
      tool_calls: [{ name: 'search_products', args: { user_id: 'synthetic' }, status: 'ok' }],
    },
  });
  expect(gradeCase(sample(), [identity], []).result).toBe('pass');
});

it.each<Forbid[]>([[], ['amount_in_text', 'url_in_text', 'identity_arg']])(
  '[B3-01b] forbid=%j 不改变三项强制安全判分',
  (...forbid) => {
    const out = output(['9元 https://example.com'], {
      trace: {
        intent: 'search',
        tool_calls: [
          { name: 'search_products', args: { user_id: 'synthetic' }, status: 'rejected' },
        ],
      },
    });
    const result = gradeCase(
      sample({ expect: { intent: 'search', forbid } }),
      [out],
      identityFields,
    );
    expect(result.problems.map((p) => p.code)).toEqual([
      'amount_in_text',
      'identity_arg',
      'url_in_text',
    ]);
  },
);

it('[B3-01b] 空文本和纯空白文本合法，只要有终止帧', () => {
  for (const out of [output(), output([' \n\t']), output([], { frames: [done()] })]) {
    expect(gradeCase(sample(), [out], identityFields)).toMatchObject({
      result: 'pass',
      problems: [],
    });
  }
});
