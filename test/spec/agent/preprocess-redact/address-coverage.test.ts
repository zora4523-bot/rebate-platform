import { expect, it } from 'vitest';
import {
  createAgentRedactor,
  maskForTrace,
  redactForModel,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';

// BR-AI-14 收货地址 / BR-AI-19 落库前脱敏，负责人 2026-10-15 口径：识别出省 / 市 / 区县任一级后，
// 其后内容遮到句末或段落结束，只保留省市。允许多遮（如「小区3号电池」被遮），不允许漏遮个人地址。
// 因此这里只断言三件事：区县及其后的详细地址原文不出现、省市保留、再脱敏不变；句末之后的普通句子
// 保留。不断言掩码样式，也不断言地址前的引导语或同一句内地址之后的文字是否被遮（多遮可接受）。
// 全部为合成输入：行政区与路名是公开地名，楼栋房号、村组与人物为虚构组合，不对应任何个人。

interface AddressCase {
  raw: string;
  /** 必须保留的省 / 市原文；只有区县、没有省市时为空。 */
  keep: readonly string[];
  /** 区县及其后的详细地址片段，三个出口都不得出现。 */
  leak: readonly string[];
}

const APP_ID = 'synthetic-app-a';

/** 用例标题里的输入按 JSON 字符串显示，换行与制表符不会把标题拆成多行。 */
function shown<T extends { raw: string }>(cases: readonly T[]): (T & { shown: string })[] {
  return cases.map((item) => ({ ...item, shown: JSON.stringify(item.raw) }));
}

async function threeExits(raw: string): Promise<Record<string, string>> {
  const model = redactForModel(raw).text;
  const stored = await createAgentRedactor().redact(APP_ID, raw);
  const trace = maskForTrace(raw);
  const nested = maskForTrace({ args: [{ note: raw }] }) as { args: [{ note: unknown }] };
  expect(typeof trace).toBe('string');
  expect(typeof nested.args[0].note).toBe('string');
  return {
    redactForModel: model,
    'createAgentRedactor().redact': stored,
    maskForTrace: trace as string,
    'maskForTrace(nested)': nested.args[0].note as string,
  };
}

async function expectAddressMasked({ raw, keep, leak }: AddressCase): Promise<void> {
  const outputs = await threeExits(raw);
  for (const [exit, out] of Object.entries(outputs)) {
    for (const part of keep) expect(out, `${exit} 应保留「${part}」：${out}`).toContain(part);
    for (const part of leak) expect(out, `${exit} 漏遮「${part}」：${out}`).not.toContain(part);
  }
  // 再脱敏不变：模型文本、存储文本与 trace 各自幂等。
  const model = redactForModel(raw).text;
  expect(redactForModel(model)).toEqual({ text: model, placeholders: {} });
  const redactor = createAgentRedactor();
  const stored = await redactor.redact(APP_ID, raw);
  expect(await redactor.redact(APP_ID, stored)).toBe(stored);
  expect(maskForTrace(raw)).toBe(stored);
  const trace = maskForTrace({ args: [raw] });
  expect(maskForTrace(trace)).toEqual(trace);
}

// Claude 换家后评审 S0 第 1 条：区县后的详细地址内部分隔后接汉字、分隔超过 3 个字符、括号与【】、
// 区县后直接句号再接详细地址。
it.each(
  shown<AddressCase>([
    {
      raw: '深圳市南山区科技园，科苑路15号',
      keep: ['深圳市'],
      leak: ['南山区', '科技园', '科苑路', '15号'],
    },
    {
      raw: '深圳市南山区科技园 科苑路15号',
      keep: ['深圳市'],
      leak: ['南山区', '科技园', '科苑路', '15号'],
    },
    {
      raw: '地址：深圳市南山区，科技园，科苑路15号，A栋1201',
      keep: ['深圳市'],
      leak: ['南山区', '科技园', '科苑路', '15号', 'A栋', '1201'],
    },
    {
      raw: '广东省深圳市福田区福华三路(会展中心对面)卓越大厦18楼',
      keep: ['广东省深圳市'],
      leak: ['福田区', '福华三路', '会展中心', '对面', '卓越大厦', '18楼'],
    },
    {
      raw: '广东省深圳市宝安区西乡街道 固戍二路 168号',
      keep: ['广东省深圳市'],
      leak: ['宝安区', '西乡', '固戍二路', '168'],
    },
    {
      raw: '广东省 深圳市 南山区 南头街道 518052 南新路1088号',
      keep: ['广东省', '深圳市'],
      leak: ['南山区', '南头', '518052', '南新路', '1088'],
    },
    {
      raw: '广东省深圳市南山区\r\n\r\n合成路88号101室',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省深圳市南山区 \r\n 合成路88号101室',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省深圳市南山区。合成路88号',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号'],
    },
    {
      raw: '广东省深圳市南山区合成路88号【101室】',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
  ]),
)(
  '[AC-B3-05a#38][BR-AI-14][BR-AI-19] 区县后分隔接汉字、长分隔串、括号与【】、句号接详细地址：$shown 三出口不留区县及详细地址',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// Claude 换家后评审 S0 第 2 条：楼栋门牌不带「号 / 室」、楼-单元-户短横线、汉字数字门牌、农村村组。
it.each(
  shown<AddressCase>([
    {
      raw: '广东省深圳市南山区科技园科兴科学园A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', '科兴科学园', 'A栋', '1201'],
    },
    {
      raw: '广东省深圳市南山区科技园A座1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A座', '1201'],
    },
    {
      raw: '北京市朝阳区望京西园三区5-2-301',
      keep: ['北京市'],
      leak: ['朝阳区', '望京西园', '三区', '5-2-301', '301'],
    },
    {
      raw: '深圳市南山区科苑路十五号',
      keep: ['深圳市'],
      leak: ['南山区', '科苑路', '十五号'],
    },
    {
      raw: '河南省周口市郸城县宁平镇王庄村三组',
      keep: ['河南省周口市'],
      leak: ['郸城县', '宁平镇', '王庄村', '三组'],
    },
  ]),
)(
  '[AC-B3-05a#39][BR-AI-14][BR-AI-19] 楼栋门牌无号室、短横线房号、汉字数字、农村村组：$shown 三出口不留区县及详细地址',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// Codex 代码评审三轮的样例：区县后换行接详细地址；省略区县，市后直接路名门牌。
it.each(
  shown<AddressCase>([
    {
      raw: '广东省深圳市南山区\n合成路88号101室',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '寄到深圳市合成路88号101室',
      keep: ['深圳市'],
      leak: ['合成路', '88号', '101室'],
    },
  ]),
)(
  '[AC-B3-05a#40][BR-AI-14][BR-AI-19] Codex 评审样例 $shown 三出口不留详细地址',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// 补充的常见真实写法：CRLF、逐行与制表符分隔、多个连续分隔、全角括号与中点、小区 / 大厦 / 层、
// 弄号、邮编在中间、收件人与地址前缀、汉字数字房号、社区村组、只有区县没有省市。
it.each(
  shown<AddressCase>([
    {
      raw: '广东省深圳市南山区\r\n合成路88号101室',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省\n深圳市\n南山区\n合成路88号101室',
      keep: ['广东省'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省\t深圳市\t南山区\t合成路88号101室',
      keep: ['广东省', '深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省深圳市南山区，，  ；合成路88号101室',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省深圳市南山区 合成小区3栋2单元502',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成小区', '3栋', '2单元', '502'],
    },
    {
      raw: '广东省深圳市南山区（科技园）A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A栋', '1201'],
    },
    {
      raw: '广东省深圳市南山区·科技园A座 1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A座', '1201'],
    },
    {
      raw: '浙江省杭州市西湖区合成小区3幢2单元502',
      keep: ['浙江省杭州市'],
      leak: ['西湖区', '合成小区', '3幢', '2单元', '502'],
    },
    {
      raw: '上海市黄浦区合成大厦18层1801',
      keep: ['上海市'],
      leak: ['黄浦区', '合成大厦', '18层', '1801'],
    },
    {
      raw: '广东省广州市天河区珠江新城合成大厦B座28层',
      keep: ['广东省广州市'],
      leak: ['天河区', '珠江新城', '合成大厦', 'B座', '28层'],
    },
    {
      raw: '上海市浦东新区张江路88弄5号1201',
      keep: ['上海市'],
      leak: ['浦东新区', '张江路', '88弄', '5号', '1201'],
    },
    {
      raw: '广东省深圳市 518052 南山区合成路88号',
      keep: ['广东省深圳市'],
      leak: ['518052', '南山区', '合成路', '88号'],
    },
    {
      raw: '收件人：合成人物张三，电话：13800000000，地址：广东省深圳市南山区合成路88号101室',
      keep: ['广东省深圳市'],
      leak: ['13800000000', '南山区', '合成路', '88号', '101室'],
    },
    {
      raw: '广东省深圳市南山区合成路八十八号一零一室',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '八十八号', '一零一室'],
    },
    {
      raw: '四川省成都市双流区黄甲街道合成社区五组',
      keep: ['四川省成都市'],
      leak: ['双流区', '黄甲', '合成社区', '五组'],
    },
    {
      raw: '寄到南山区科苑路十五号',
      keep: [],
      leak: ['南山区', '科苑路', '十五号'],
    },
    {
      raw: '南山区科技园A栋1201',
      keep: [],
      leak: ['南山区', '科技园', 'A栋', '1201'],
    },
  ]),
)(
  '[AC-B3-05a#41][BR-AI-14][BR-AI-19] 常见真实写法 $shown 三出口不留区县及详细地址',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// 句末边界：地址后经句号 / 问号 / 感叹号（其后可再换行）接普通句子，普通句子原样保留。
// 负责人 2026-10-15 第二次额外口径起换行不算结束，换行分段前须有句末标点。
// 普通句子都不含行政区标记字；地址与句末标点之间的文字被遮可以接受，不做断言。
it.each(
  shown<AddressCase & { after: readonly string[] }>([
    {
      raw: '寄到深圳市南山区科技园A栋1201。谢谢',
      keep: ['深圳市'],
      leak: ['南山区', '科技园', 'A栋', '1201'],
      after: ['谢谢'],
    },
    {
      raw: '寄到广东省深圳市南山区合成路88号101室！帮我找个蓝牙耳机',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
      after: ['帮我找个蓝牙耳机'],
    },
    {
      raw: '能寄到浙江省杭州市西湖区文三路90号吗？顺便推荐个保温杯',
      keep: ['浙江省杭州市'],
      leak: ['西湖区', '文三路', '90号'],
      after: ['顺便推荐个保温杯'],
    },
    {
      raw: '寄到广东省深圳市南山区科技园A座1201?有没有便宜点的保温杯',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A座', '1201'],
      after: ['有没有便宜点的保温杯'],
    },
    {
      raw: '寄到广东省深圳市南山区科技园A座1201!想买一双跑步鞋',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A座', '1201'],
      after: ['想买一双跑步鞋'],
    },
    {
      raw: '广东省深圳市南山区合成路88号101室。\n想买一双跑步鞋',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
      after: ['想买一双跑步鞋'],
    },
    {
      raw: '广东省深圳市南山区合成路88号101室。\r\n想买一双跑步鞋',
      keep: ['广东省深圳市'],
      leak: ['南山区', '合成路', '88号', '101室'],
      after: ['想买一双跑步鞋'],
    },
    {
      raw: '地址是广东省深圳市南山区科技园A座1201。想买一双跑步鞋。有没有便宜点的保温杯？',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A座', '1201'],
      after: ['想买一双跑步鞋', '有没有便宜点的保温杯？'],
    },
  ]),
)(
  '[AC-B3-05a#42][BR-AI-14][BR-AI-19] 句末边界 $shown：地址遮到句末，其后的普通句子保留',
  async ({ after, ...address }) => {
    await expectAddressMasked(address);
    const last = after.at(-1) ?? '';
    for (const [exit, out] of Object.entries(await threeExits(address.raw))) {
      for (const sentence of after) {
        expect(out, `${exit} 应保留「${sentence}」：${out}`).toContain(sentence);
      }
      expect(out.endsWith(last), `${exit} 应以「${last}」结尾：${out}`).toBe(true);
    }
  },
);

// 不含行政区标记字、也不含长数字或邮箱的普通需求，三个出口都原样返回。
it.each(['帮我找个蓝牙耳机', '想买一双跑步鞋，四十二码', '有没有便宜点的保温杯？要能装热水的'])(
  '[AC-B3-05a#43][BR-AI-14][BR-AI-19] 普通句子 %s 三出口原样保留',
  async (raw) => {
    expect(redactForModel(raw)).toEqual({ text: raw, placeholders: {} });
    for (const [exit, out] of Object.entries(await threeExits(raw))) {
      expect(out, exit).toBe(raw);
    }
  },
);
