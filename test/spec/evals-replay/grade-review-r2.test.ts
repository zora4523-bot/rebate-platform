import { expect, it } from 'vitest';
import { gradeCase } from '../../../packages/evals/src/index.ts';
import { card, done, frame, identityFields, output, passed, sample } from './fixtures.ts';

it.each(['去 www.example.org/x 看', 'www.example.hk'])(
  '[BR-AI-06] www 独立模式 %s 判 URL，不能依赖 scheme 或列出的域名后缀', (text) => {
    const result = gradeCase(sample(), [output([text])], identityFields);
    expect(result).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
    expect(result.problems).toEqual([
      expect.objectContaining({ code: 'url_in_text', layer: 'L1', turn: 1, message: expect.stringMatching(/URL/i) }),
    ]);
    expect(result.problems[0]?.message).not.toContain('口令');
  },
);

it.each(['fallback_text', 'data'] as const)(
  '[BR-AI-06] 卡片 %s 内的金额与链接不参与文本判分', (location) => {
    const c = sample({ expect: { intent: 'search', cards: ['notice'] } });
    const payload = card('notice');
    if (location === 'fallback_text') payload.data.fallback_text = '¥29.90 https://example.com';
    else payload.data.data = { level: 'info', text_key: 'synthetic.notice', actions: [], text: '¥29.90 https://example.com' };
    const out = output([], { frames: [frame('text.delta', { delta: '请查看卡片。' }), payload, done()] });
    expect(gradeCase(c, [out], identityFields)).toEqual(passed(c));
  },
);

it.each(['一百元', '两块', '五千元', '三万元', '零元', '〇元'])(
  '[BR-AI-06] 中文数字金额 %s 计 amount_in_text', (text) => {
    expect(gradeCase(sample(), [output([text])], identityFields)).toMatchObject({
      result: 'fail', first_failed_layer: 'L1',
      problems: [expect.objectContaining({ code: 'amount_in_text', layer: 'L1', turn: 1 })],
    });
  },
);

it.each(['example.community', 'config.cnf', 'a.netx', 'example.topology', 'example.ccx', 'example.viper'])(
  '[BR-AI-06] 域名后缀必须完整结束，%s 不误报 URL', (text) => {
    const c = sample();
    expect(gradeCase(c, [output([text])], identityFields)).toEqual(passed(c));
  },
);

it('[B3-01b] 唯一期望参数为 null 时，实际缺键仍判 args_mismatch', () => {
  const c = sample({ expect: { intent: 'search', tools: [{ name: 'search_products', args: { a: null } }] } });
  const out = output([], { trace: {
    intent: 'search', tool_calls: [{ name: 'search_products', args: {}, status: 'ok' }],
  } });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'fail', first_failed_layer: 'L3',
    problems: [expect.objectContaining({ code: 'args_mismatch', layer: 'L3', turn: 1 })],
  });
  out.trace.tool_calls[0] = { name: 'search_products', args: { a: null }, status: 'ok' };
  expect(gradeCase(c, [out], identityFields)).toEqual(passed(c));
});

it.each([
  { event: 'card', deltas: ['只要 29.', '9 元'], code: 'amount_in_text' },
  { event: 'tool.status', deltas: ['只要 29.', '9 元'], code: 'amount_in_text' },
  { event: 'card', deltas: ['去 htt', 'ps://example.org/x 看'], code: 'url_in_text' },
  { event: 'tool.status', deltas: ['去 htt', 'ps://example.org/x 看'], code: 'url_in_text' },
])('[BR-AI-06] 跨 $event 帧仍按下发顺序拼接并判 $code', ({ event, deltas, code }) => {
  const between = event === 'card' ? card() : frame('tool.status', {
    tool: 'search_products', phase: 'end', display_text: '查询完成',
  });
  const out = output([], { frames: [
    frame('text.delta', { delta: deltas[0] }), between,
    frame('text.delta', { delta: deltas[1] }), done(),
  ] });
  expect(gradeCase(sample(), [out], identityFields)).toMatchObject({
    result: 'fail', first_failed_layer: 'L1',
    problems: [expect.objectContaining({ code, layer: 'L1', turn: 1 })],
  });
});

it.each([
  'https://example.org/x', 'http://example.org/x', 'demo://open', 'example.com',
])('[BR-AI-06] URL 命中 %s 的 message 不混入口令类型', (text) => {
  const result = gradeCase(sample(), [output([text])], identityFields);
  expect(result.problems).toEqual([
    expect.objectContaining({ code: 'url_in_text', message: expect.stringMatching(/URL/i) }),
  ]);
  expect(result.problems[0]?.message).not.toContain('口令');
});

it.each([
  '￥Ab123456￥', '$Ab123456$', '€Ab123456€', '(Ab123456)', '（Ab123456）', '/Ab123456/',
  '复制合成片段打开淘宝', '复制合成片段打开京东', '复制合成片段打开拼多多',
])('[BR-AI-06] 口令命中 %s 的 message 不混入 URL 类型', (text) => {
  const result = gradeCase(sample(), [output([text])], identityFields);
  expect(result.problems).toEqual([
    expect.objectContaining({ code: 'url_in_text', message: expect.stringContaining('口令') }),
  ]);
  expect(result.problems[0]?.message).not.toMatch(/URL/i);
});
