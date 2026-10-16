import { describe, expect, it } from 'vitest';

import { createAgentRedactor, maskForTrace, redactForModel } from './index.ts';

// Synthetic inputs only: public place names, invented roads, buildings and accounts.
const APP_ID = 'synthetic-app-a';

async function outputs(raw: string): Promise<string[]> {
  return [
    redactForModel(raw).text,
    await createAgentRedactor().redact(APP_ID, raw),
    maskForTrace(raw) as string,
  ];
}

async function expectIdempotent(raw: string): Promise<void> {
  const model = redactForModel(raw).text;
  expect(redactForModel(model)).toEqual({ text: model, placeholders: {} });
  const stored = await createAgentRedactor().redact(APP_ID, raw);
  expect(await createAgentRedactor().redact(APP_ID, stored)).toBe(stored);
}

describe('[BR-AI-14][BR-AI-19] address region ends only at the end of the sentence', () => {
  it.each([
    ['广东省深圳市南山区' + '合成'.repeat(110) + '路15号A栋1201', 'A栋1201'],
    ['广东省深圳市南山区' + '合成大道8号，'.repeat(40) + '科苑路15号A栋1201', '科苑路'],
  ])(
    'masks a long address to its end, so a second pass changes nothing (%#)',
    async (raw, tail) => {
      for (const out of await outputs(raw)) {
        expect(out.startsWith('广东省深圳市')).toBe(true);
        expect(out).not.toContain(tail);
      }
      await expectIdempotent(raw);
    },
  );

  it.each(['广东省A栋?a.b@c.cn', 'a.b@c.cn?x@y.cn', '电话x@y.cn13800000000?a@b.cn'])(
    'keeps a mask next to an e-mail stable on a second pass: %s',
    async (raw) => {
      for (const out of await outputs(raw)) expect(out).not.toMatch(/a\.b@|x@|13800000000/);
      await expectIdempotent(raw);
    },
  );

  it('keeps a link carried out of an address region apart from the text after it', async () => {
    const raw = '广东省深圳市南山区合成路88号https://example.invalid/90000000001?x@y.cn的！';
    const stored = await createAgentRedactor().redact(APP_ID, raw);
    expect(stored).toContain('https://example.invalid/90000000001');
    expect(stored).not.toMatch(/合成路|88号/);
    await expectIdempotent(raw);
  });
});

describe('[BR-AI-14] weak anchors: everyday words mask only when an address follows', () => {
  it.each([
    '这个能省多少钱',
    '这个能省10元吗？',
    '有什么区别吗',
    '我的家乡很美',
    '回县城买东西',
    '淘宝联盟返利50元',
    '冰镇可乐来一箱',
    '去超市买3个苹果',
    '市场价199元的耳机',
    '旗舰店有没有优惠',
    '地址在哪里改',
  ])('leaves %s unchanged', async (raw) => {
    for (const out of await outputs(raw)) expect(out).toBe(raw);
  });

  it.each([
    ['郸城县城关镇王庄村3组', ['郸城县', '王庄村', '3组']],
    ['浙江省钱塘区合成路8号', ['钱塘区', '合成路']],
    ['锡林郭勒盟锡林浩特市合成路8号', ['锡林浩特', '合成路']],
    ['延边朝鲜族自治州延吉市合成路8号', ['延吉', '合成路']],
    ['香港特别行政区九龙合成道8号', ['九龙', '8号']],
    ['我的地址是科技园A栋1201', ['科技园', 'A栋', '1201']],
  ] as const)('masks the detail after %s', async (raw, leak) => {
    for (const out of await outputs(raw)) {
      for (const part of leak) expect(out).not.toContain(part);
    }
    await expectIdempotent(raw);
  });

  it('a label before a province keeps the province and city', async () => {
    for (const out of await outputs('地址：广东省深圳市南山区科技园A栋1201')) {
      expect(out.startsWith('地址：广东省深圳市')).toBe(true);
      expect(out).not.toMatch(/南山区|科技园|1201/);
    }
  });

  it('a sentence end right after the units goes on only into an address-like sentence', async () => {
    expect(redactForModel('广东省深圳市南山区。帮我找充电宝').text).toMatch(/。帮我找充电宝$/);
    expect(redactForModel('我在深圳市。帮我找充电宝').text).toBe('我在深圳市。帮我找充电宝');
    const next = redactForModel('寄到南山区。合成路88号。谢谢').text;
    expect(next).toMatch(/。谢谢$/);
    expect(next).not.toMatch(/南山区|合成路|88/);
  });
});
