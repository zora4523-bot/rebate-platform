import { expect, it } from 'vitest';
import { proceed, setup } from './kit.ts';

// BR-AI-01 A 级 parse_input：出现顺序去重，再取前 3；第 4 个起只出一次 notice。
const a = 'https://example.invalid/synthetic-a';
const b = 'https://example.invalid/synthetic-b';
const c = 'https://example.invalid/synthetic-c';
const d = 'https://example.invalid/synthetic-d';

it.each([
  { label: '零个', message: '合成保温杯', expected: [] },
  { label: '一个', message: a, expected: [{ kind: 'url', raw: a, index: 0 }] },
  {
    label: '三个',
    message: `${a} ${b} ${c}`,
    expected: [
      { kind: 'url', raw: a, index: 0 },
      { kind: 'url', raw: b, index: a.length + 1 },
      { kind: 'url', raw: c, index: a.length + b.length + 2 },
    ],
  },
])(
  '[AC-B3-05d#11][BR-AI-01] $label链接按原文位置保留且无超限 notice',
  async ({ message, expected }) => {
    const r = setup();
    const result = proceed(await r.check(message));
    expect(result.links).toEqual(expected);
    expect(result.notices).toEqual([]);
  },
);

it('[AC-B3-05d#12][BR-AI-01] 第四个链接不进入处理候选且返回 link_limit 文案卡', async () => {
  const r = setup();
  const result = proceed(await r.check(`${a} ${b} ${c} ${d}`));
  expect(result.links).toEqual([
    { kind: 'url', raw: a, index: 0 },
    { kind: 'url', raw: b, index: a.length + 1 },
    { kind: 'url', raw: c, index: a.length + b.length + 2 },
  ]);
  expect(result.notices).toEqual([
    {
      type: 'notice',
      schema_version: 1,
      data: { level: 'info', text_key: 'agent.notice.link_limit', actions: [] },
      fallback_text: '合成文案:synthetic-input-app:agent.notice.link_limit',
    },
  ]);
  expect(r.text).toHaveBeenCalledWith('synthetic-input-app', 'agent.notice.link_limit');
});

it('[AC-B3-05d#13][BR-AI-01] 重复链接先去重，后面的第二第三个不同链接不被挤掉', async () => {
  const r = setup();
  const result = proceed(await r.check(`${a} ${a} ${b} ${a} ${c}`));
  expect(result.links).toEqual([
    { kind: 'url', raw: a, index: 0 },
    { kind: 'url', raw: b, index: 2 * (a.length + 1) },
    { kind: 'url', raw: c, index: 3 * (a.length + 1) + b.length + 1 },
  ]);
  expect(result.notices).toEqual([]);
});

it('[AC-B3-05d#14][BR-AI-01] 去重后仍超限时只保留前三个不同链接', async () => {
  const r = setup();
  const result = proceed(await r.check(`${a} ${a} ${b} ${c} ${d} ${d}`));
  expect(result.links.map((link) => link.raw)).toEqual([a, b, c]);
  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]).toMatchObject({
    type: 'notice',
    data: { text_key: 'agent.notice.link_limit' },
  });
});

it('[AC-B3-05d#15][BR-AI-01][BR-AI-05] 口令与 URL 按原文顺序共用候选上限', async () => {
  const r = setup();
  const password = '￥SyntheticCode￥';
  const result = proceed(await r.check(`${password} ${a} ${password} ${b} ${c}`));
  expect(result.links).toEqual([
    { kind: 'tpwd', raw: password, index: 0 },
    { kind: 'url', raw: a, index: password.length + 1 },
    { kind: 'url', raw: b, index: 2 * (password.length + 1) + a.length + 1 },
  ]);
  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]).toMatchObject({
    type: 'notice',
    data: { text_key: 'agent.notice.link_limit' },
  });
  expect(result.untrustedInput).toBe(true);
});
