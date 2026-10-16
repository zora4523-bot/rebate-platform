import { expect, it } from 'vitest';
import {
  redactForModel,
  restorePlaceholders,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import { findCandidateSpans } from '../../../../apps/api/src/modules/parsing/index.ts';

// 全部为合成输入。BR-AI-14 只规定保留哪些字符，没有规定掩码字符及个数。
it.each(['13000000000', '13800000000', '19900000000'])(
  '[AC-B3-05a#1][BR-AI-14] 手机号 %s 保留前三位和后四位，不占用数字表',
  (phone) => {
    const result = redactForModel(phone);
    expect(result.text).toMatch(new RegExp(`^${phone.slice(0, 3)}[^0-9]+0000$`));
    expect(result.text).not.toContain(phone);
    expect(result.placeholders).toEqual({});
  },
);

it.each(['013800000000', '138000000000', '12000000000', '38123456789'])(
  '[AC-B3-05a#2][BR-AI-14] 手机前后邻接数字或不符手机前缀的 %s 按整段长数字处理',
  (raw) => {
    const result = redactForModel(raw);
    expect(result.text).toBe('<num_1>');
    expect(result.placeholders).toEqual({ '<num_1>': raw });
  },
);

it('[AC-B3-05a#3][BR-AI-14] 手机号紧邻非数字仍识别，其他十位数字不脱敏', () => {
  const result = redactForModel('A13800000000Z 合成编号 3812345678');
  expect(result.text).toMatch(/^A138[^0-9]+0000Z 合成编号 3812345678$/);
  expect(result.placeholders).toEqual({});
});

// 合成行政区 990101，无真实身份：前 17 位加权和分别为 234 / 244，校验位为 9 / X。
it.each([
  ['990101199001010019', '0019'],
  ['99010119900101006X', '006X'],
])('[AC-B3-05a#4][BR-AI-14] 校验位正确的合成身份证 %s 只保留后四位', (raw, tail) => {
  const result = redactForModel(raw);
  expect(result.text).toMatch(new RegExp(`^[^0-9]+${tail}$`));
  expect(result.placeholders).toEqual({});
});

it('[AC-B3-05a#5][BR-AI-14] 身份证校验位错误的全数字串回落到长数字占位', () => {
  const result = redactForModel('990101199001010018');
  expect(result.text).toBe('<num_1>');
  expect(result.placeholders).toEqual({ '<num_1>': '990101199001010018' });
});

it.each(['synthetic@example.invalid', 'synthetic.tag+demo@sub.example.invalid'])(
  '[AC-B3-05a#6][BR-AI-14] 邮箱 %s 保留首字符与域名，隐藏其余账号',
  (email) => {
    const result = redactForModel(email);
    expect(result.text[0]).toBe(email[0]);
    expect(result.text.slice(1, result.text.indexOf('@'))).not.toMatch(/[A-Za-z0-9]/);
    expect(result.text.slice(result.text.indexOf('@'))).toBe(email.slice(email.indexOf('@')));
    expect(result.text).not.toContain('synthetic');
    expect(result.text).not.toContain('tag+demo');
    expect(result.placeholders).toEqual({});
  },
);

it.each([
  ['广东省深圳市南山区合成路88号101室', '广东省深圳市'],
  ['浙江省杭州市西湖区合成街9号202室', '浙江省杭州市'],
  ['广东省惠州市博罗县合成路8号303室', '广东省惠州市'],
])('[AC-B3-05a#7][BR-AI-14] 省市区县与详细地址 %s 只保留省市', (address, region) => {
  const result = redactForModel(`寄到${address}。谢谢`);
  expect(result.text).toContain(`寄到${region}`);
  expect(result.text).toMatch(/谢谢$/);
  expect(result.text).not.toMatch(/南山区|西湖区|博罗县|合成路|合成街|88|101|202|303/);
  expect(result.placeholders).toEqual({});
});

it('[AC-B3-05a#8][BR-AI-14] 姓名、普通需求、短数字与空串不做额外转换', () => {
  for (const text of ['', '合成人物张三想买蓝牙耳机 1234567890']) {
    expect(redactForModel(text)).toEqual({ text, placeholders: {} });
  }
});

it('[AC-B3-05a#9][BR-AI-14] 占位编号按首次出现排序，相同原值复用编号', () => {
  const result = redactForModel(
    '订单 3812345678901234567，商品 28000000001，订单 3812345678901234567',
  );
  expect(result.text).toBe('订单 <num_1>，商品 <num_2>，订单 <num_1>');
  expect(result.placeholders).toEqual({
    '<num_1>': '3812345678901234567',
    '<num_2>': '28000000001',
  });
  expect(result.text).not.toMatch(/\d{11,}/);
});

it('[AC-B3-05a#10][BR-AI-14] 占位表只属于本次调用，交错调用不累积原文或编号', () => {
  const first = redactForModel('3812345678901234567');
  const second = redactForModel('28000000001');
  const empty = redactForModel('合成耳机');
  expect(first).toEqual({ text: '<num_1>', placeholders: { '<num_1>': '3812345678901234567' } });
  expect(second).toEqual({ text: '<num_1>', placeholders: { '<num_1>': '28000000001' } });
  expect(empty.placeholders).toEqual({});
  expect(restorePlaceholders('<num_1>', first.placeholders)).toBe('3812345678901234567');
  expect(restorePlaceholders('<num_1>', second.placeholders)).toBe('28000000001');
});

it.each([1, 3, 5])(
  '[AC-B3-05a#11][BR-AI-14] 移出全部 %i 个链接，链接数字不消耗占位编号',
  (count) => {
    const links = [
      'https://example.invalid/90000000001',
      'http://example.invalid/90000000002?q=synthetic',
      'https://example.invalid/90000000003',
      'https://example.invalid/90000000004?phone=13800000000',
      'https://example.invalid/90000000005#990101199001010019',
    ].slice(0, count);
    const result = redactForModel(
      `合成开头 ${links.join(' 比较 ')} 订单 3812345678901234567 合成结尾`,
    );
    expect(result.text).toContain('合成开头');
    expect(result.text).toContain('合成结尾');
    expect(result.text).toContain('订单 <num_1>');
    expect(result.text).not.toMatch(/https?:\/\/|example\.invalid|\d{11,}/);
    expect(result.placeholders).toEqual({ '<num_1>': '3812345678901234567' });
    for (const link of links) expect(result.text).not.toContain(link);
  },
);

it('[AC-B3-05a#12][BR-AI-14] 链接口令混排超过三项仍全移出，口令字母数字不进入占位表', () => {
  const result = redactForModel(
    '合成 ￥Ab3812345678901234567￥ https://example.invalid/90000000001 ' +
      '$Cd28000000001$ https://example.invalid/90000000002 ¥Ef38000000001¥ 28000000001 结束',
  );
  expect(result.text).toContain('合成');
  expect(result.text).toContain('结束');
  expect(result.text).toContain('<num_1>');
  expect(result.text).not.toMatch(/Ab|Cd|Ef|https?:\/\/|\d{11,}|[￥$¥]/);
  expect(result.placeholders).toEqual({ '<num_1>': '28000000001' });
});

it('[AC-B3-05a#13][BR-AI-14] 再脱敏保持模型文本不变，已有占位符不产生新的原值表', () => {
  const first = redactForModel(
    '合成人物张三 13800000000 99010119900101006X synthetic@example.invalid ' +
      '广东省深圳市南山区合成路88号101室 3812345678901234567',
  );
  const again = redactForModel(first.text);
  expect(again.text).toBe(first.text);
  expect(again.placeholders).toEqual({});
});

// 两个 19 位订单号分别在末尾、开头含校验位正确的 18 位合成身份证
// 990101199001010019；BR-AI-14 的身份证识别要求整段恰好 18 位。
it.each(['7990101199001010019', '9901011990010100197'])(
  '[AC-B3-05a#35][BR-AI-14] 19 位订单号 %s 内的有效身份证片段不抢占长数字匹配',
  (raw) => {
    const result = redactForModel(raw);
    expect(result.text).toBe('<num_1>');
    expect(result.placeholders).toEqual({ '<num_1>': raw });
    expect(restorePlaceholders({ order_no: result.text }, result.placeholders)).toEqual({
      order_no: raw,
    });
  },
);

it.each([
  {
    suffix: '电话13800000000',
    pattern: /，电话138[^0-9]+0000$/,
    placeholders: {},
  },
  {
    suffix: '订单3812345678901234567',
    pattern: /，订单<num_1>$/,
    placeholders: { '<num_1>': '3812345678901234567' },
  },
])(
  '[AC-B3-05a#36][BR-AI-14] 模型只移出候选链接，中文标点后的 $suffix 仍脱敏',
  ({ suffix, pattern, placeholders }) => {
    const link = 'https://example.invalid/90000000001';
    const input = `链接${link}，${suffix}`;
    expect(findCandidateSpans(input)).toEqual([{ kind: 'url', raw: link, index: 2 }]);
    const result = redactForModel(input);
    expect(result.text).toMatch(/^链接/);
    expect(result.text).toMatch(pattern);
    expect(result.text).not.toMatch(/https?:\/\/|\d{11,}/);
    expect(result.placeholders).toEqual(placeholders);
  },
);
