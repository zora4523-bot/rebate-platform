import { expect, it } from 'vitest';
import {
  createAgentRedactor,
  maskForTrace,
  redactForModel,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';

// BR-AI-14 收货地址 / BR-AI-19 落库前脱敏，负责人 2026-10-15 第二次额外口径：出现任一行政区锚点
// （省、市、区、县、自治区 / 州 / 县、盟、旗、地区、特别行政区，以及镇、乡、街道、村、工业园区 /
// 开发区 / 新区）后，一直遮到 。！？（含作句末的半角 . ! ?）或文本末尾；逗号、顿号、分号、空格、
// 换行都不算结束。链接与口令照常保留原文。允许多遮，不允许漏遮。
// 这里只断言：门牌、楼栋、房号、村组等详细信息三个出口都不出现；省市（写了时）保留；句末之后的
// 普通句子保留；再脱敏不变。不断言掩码样式，也不断言同一句内其他文字是否被遮（多遮可接受）。
// 全部为合成输入：行政区与路名是公开地名，楼栋房号、村组与人物为虚构组合，不对应任何个人。

interface AddressCase {
  raw: string;
  /** 必须保留的省 / 市原文；没写省市或前面带表单标签时为空（标签行被多遮可以接受）。 */
  keep: readonly string[];
  /** 详细地址片段，三个出口都不得出现。 */
  leak: readonly string[];
}

interface SentenceCase extends AddressCase {
  /** 句末之后的普通句子，三个出口都原样保留，且输出以最后一项结尾。 */
  after: readonly string[];
}

interface CandidateCase extends AddressCase {
  /** 链接或口令原文，存储形态（存储与 trace）逐字保留。 */
  candidates: readonly string[];
  after: readonly string[];
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

async function expectAfterKept(raw: string, after: readonly string[]): Promise<void> {
  const last = after.at(-1);
  if (last === undefined) return;
  for (const [exit, out] of Object.entries(await threeExits(raw))) {
    for (const sentence of after) {
      expect(out, `${exit} 应保留「${sentence}」：${out}`).toContain(sentence);
    }
    expect(out.endsWith(last), `${exit} 应以「${last}」结尾：${out}`).toBe(true);
  }
}

// 评审 r2 S0 第 1 条：锚点之后空格 / 逗号 / 顿号 / 分号接一个「不像地址」的分句，遮罩不得提前结束；
// 只写省市、区县不带「区」字时同样遮到句末；英文 / 拼音写法的路名门牌。
it.each(
  shown<AddressCase>([
    {
      raw: '北京市朝阳区望京 SOHO 塔1 1201',
      keep: ['北京市'],
      leak: ['朝阳区', '望京', 'SOHO', '塔1', '1201'],
    },
    {
      raw: '北京市朝阳区 望京 SOHO T1 1201',
      keep: ['北京市'],
      leak: ['朝阳区', '望京', 'SOHO', 'T1', '1201'],
    },
    {
      raw: '广东省深圳市南山区科技园 科兴 A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', '科兴', 'A栋', '1201'],
    },
    {
      raw: '上海市徐汇区 漕河泾 合成 3号楼1201',
      keep: ['上海市'],
      leak: ['徐汇区', '漕河泾', '合成', '3号楼', '1201'],
    },
    {
      raw: '广东省深圳市，南山，粤海，科技园A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山', '粤海', '科技园', 'A栋', '1201'],
    },
    {
      raw: '浙江省 杭州 西湖 文三路90号',
      keep: ['浙江省'],
      leak: ['杭州', '西湖', '文三路', '90号'],
    },
    {
      raw: '上海市 浦东 张江 合成路88弄5号',
      keep: ['上海市'],
      leak: ['浦东', '张江', '合成路', '88弄', '5号'],
    },
    {
      raw: '河南省周口市 郸城 宁平 王庄村三组',
      keep: ['河南省周口市'],
      leak: ['郸城', '宁平', '王庄村', '三组'],
    },
    {
      raw: '北京市 朝阳 望京 合成小区5-2-301',
      keep: ['北京市'],
      leak: ['朝阳', '望京', '合成小区', '5-2-301', '301'],
    },
    {
      raw: '广东省深圳市南山区, Keyuan Road No.15, Building A, Room 1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', 'Keyuan', 'Road', 'No.15', 'Building A', 'Room', '1201'],
    },
    {
      raw: '广东省深圳市南山区、粤海、科技园、A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '粤海', '科技园', 'A栋', '1201'],
    },
    {
      raw: '广东省深圳市；南山；粤海；科技园A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山', '粤海', '科技园', 'A栋', '1201'],
    },
    {
      raw: '北京市朝阳区望京，SOHO，塔1，1201',
      keep: ['北京市'],
      leak: ['朝阳区', '望京', 'SOHO', '塔1', '1201'],
    },
  ]),
)(
  '[AC-B3-05a#44][BR-AI-14][BR-AI-19] 锚点后空格 / 逗号 / 顿号 / 分号接不像地址的分句：$shown 三出口仍遮到句末',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// 评审 r2 S0 第 2 条：换行不算结束。跨行详细地址、表单标签行（楼号 / 房间号 / 小区 / 街道）、
// 地区行与详细地址行之间夹收件人行、详细地址行在前。
it.each(
  shown<AddressCase>([
    {
      raw: '广东省深圳市南山区科技园\n科苑路15号A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', '科苑路', '15号', 'A栋', '1201'],
    },
    {
      raw: '深圳市南山区 科技园\n科兴科学园A栋1201',
      keep: ['深圳市'],
      leak: ['南山区', '科技园', '科兴科学园', 'A栋', '1201'],
    },
    {
      raw: '广东省深圳市南山区科苑路15号\nA栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科苑路', '15号', 'A栋', '1201'],
    },
    {
      raw: '广东省深圳市南山区科苑路15号\r\nA栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科苑路', '15号', 'A栋', '1201'],
    },
    {
      raw: '地区：广东省深圳市南山区科技园\n楼号：A栋1201',
      keep: [],
      leak: ['南山区', '科技园', 'A栋', '1201'],
    },
    {
      raw: '地区：广东省深圳市南山区科技园\n房间号：1201',
      keep: [],
      leak: ['南山区', '科技园', '1201'],
    },
    {
      raw: '地区：广东省深圳市南山区科技园\n小区：合成花园A栋1201',
      keep: [],
      leak: ['南山区', '科技园', '合成花园', 'A栋', '1201'],
    },
    {
      raw: '所在地区:广东省深圳市南山区粤海街道科技园\n街道:科苑路15号A栋1201',
      keep: [],
      leak: ['南山区', '粤海街道', '科技园', '科苑路', '15号', 'A栋', '1201'],
    },
    {
      raw: '所在地区：广东省深圳市南山区\n收货人：张三\n手机：13800000000\n详细地址：科技园A栋1201',
      keep: [],
      leak: ['南山区', '13800000000', '科技园', 'A栋', '1201'],
    },
    {
      raw: '详细地址：科技园A栋1201\n所在地区：广东省深圳市南山区',
      keep: [],
      leak: ['科技园', 'A栋', '1201', '南山区'],
    },
  ]),
)(
  '[AC-B3-05a#45][BR-AI-14][BR-AI-19] 换行不算结束：$shown 三出口不留下一行的详细地址',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// 评审 r2 S1：没写省市，以工业园区 / 镇 / 乡 / 地区 / 旗为锚点；县级名称之后的内容不得留在原文。
// 另补负责人口径列出的开发区、新区、街道、村作锚点的写法。
it.each(
  shown<AddressCase>([
    {
      raw: '苏州工业园区星湖街328号',
      keep: [],
      leak: ['星湖街', '328'],
    },
    {
      raw: '寄到苏州工业园区星湖街328号',
      keep: [],
      leak: ['星湖街', '328'],
    },
    {
      raw: '古城镇王庄村3组',
      keep: [],
      leak: ['王庄村', '3组'],
    },
    {
      raw: '黄家乡合成村3组',
      keep: [],
      leak: ['合成村', '3组'],
    },
    {
      raw: '喀什地区合成路8号3栋201',
      keep: [],
      leak: ['合成路', '8号', '3栋', '201'],
    },
    {
      raw: '杭锦旗锡尼镇合成路8号',
      keep: [],
      leak: ['锡尼镇', '合成路', '8号'],
    },
    {
      raw: '寄到合成经济技术开发区合成大道8号A栋1201',
      keep: [],
      leak: ['合成大道', '8号', 'A栋', '1201'],
    },
    {
      raw: '寄到滨海新区 合成 A栋1201',
      keep: [],
      leak: ['A栋', '1201'],
    },
    {
      raw: '寄到粤海街道 科技园 A栋1201',
      keep: [],
      leak: ['科技园', 'A栋', '1201'],
    },
    {
      raw: '寄到王庄村3组15号',
      keep: [],
      leak: ['3组', '15号'],
    },
  ]),
)(
  '[AC-B3-05a#46][BR-AI-14][BR-AI-19] 没写省市、以园区 / 镇 / 乡 / 地区 / 旗 / 街道 / 村为锚点：$shown 三出口不留其后的详细地址',
  async (address) => {
    await expectAddressMasked(address);
  },
);

// 句末界定：只有 。！？（及作句末的半角 . ! ?）结束遮罩；其后的普通句子原样保留。
// 普通句子都不含行政区标记字；锚点到句末之间的文字被遮可以接受，不做断言。
it.each(
  shown<SentenceCase>([
    {
      raw: '寄到浙江省杭州市西湖区文三路90号。帮我找充电宝',
      keep: ['浙江省杭州市'],
      leak: ['西湖区', '文三路', '90号'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '寄到广东省深圳市南山区，粤海，科技园A栋1201。帮我找充电宝',
      keep: ['广东省深圳市'],
      leak: ['南山区', '粤海', '科技园', 'A栋', '1201'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '能寄到浙江省 杭州 西湖 文三路90号吗？帮我找充电宝',
      keep: ['浙江省'],
      leak: ['杭州', '西湖', '文三路', '90号'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '北京市朝阳区望京 SOHO 塔1 1201！帮我找充电宝',
      keep: ['北京市'],
      leak: ['朝阳区', '望京', 'SOHO', '塔1', '1201'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '广东省深圳市南山区科技园\n科苑路15号A栋1201。帮我找充电宝',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', '科苑路', '15号', 'A栋', '1201'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '寄到广东省深圳市南山区科技园A栋1201?帮我找充电宝',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A栋', '1201'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '寄到广东省深圳市南山区科技园A栋1201!帮我找充电宝',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A栋', '1201'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '广东省深圳市南山区, Keyuan Road No.15, Building A, Room 1201. 帮我找充电宝',
      keep: ['广东省深圳市'],
      leak: ['南山区', 'Keyuan', 'Road', 'No.15', 'Building A', 'Room', '1201'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '苏州工业园区星湖街328号。帮我找充电宝。有没有便宜点的保温杯？',
      keep: [],
      leak: ['星湖街', '328'],
      after: ['帮我找充电宝', '有没有便宜点的保温杯？'],
    },
  ]),
)(
  '[AC-B3-05a#47][BR-AI-14][BR-AI-19] 句末界定 $shown：地址遮到句末，其后的普通句子保留',
  async ({ after, ...address }) => {
    await expectAddressMasked(address);
    await expectAfterKept(address.raw, after);
  },
);

// 链接与口令夹在地址中间或在句末之前：地址照常遮到句末，存储形态（存储与 trace）逐字保留链接 /
// 口令原文；模型形态按既有规则移出链接 / 口令，这里只断言详细地址不出现。
it.each(
  shown<CandidateCase>([
    {
      raw: '寄到广东省深圳市南山区 https://example.invalid/90000000001 科技园A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A栋', '1201'],
      candidates: ['https://example.invalid/90000000001'],
      after: [],
    },
    {
      raw: '广东省深圳市，南山，https://example.invalid/90000000002，粤海，科技园A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山', '粤海', '科技园', 'A栋', '1201'],
      candidates: ['https://example.invalid/90000000002'],
      after: [],
    },
    {
      raw: '浙江省 杭州 西湖 $Cd123456$ 文三路90号',
      keep: ['浙江省'],
      leak: ['杭州', '西湖', '文三路', '90号'],
      candidates: ['$Cd123456$'],
      after: [],
    },
    {
      raw: '广东省深圳市南山区科技园\n￥Ab123456￥\n科苑路15号A栋1201',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', '科苑路', '15号', 'A栋', '1201'],
      candidates: ['￥Ab123456￥'],
      after: [],
    },
    {
      raw: '寄到广东省深圳市南山区科技园A栋1201 ￥Ab123456￥。帮我找充电宝',
      keep: ['广东省深圳市'],
      leak: ['南山区', '科技园', 'A栋', '1201'],
      candidates: ['￥Ab123456￥'],
      after: ['帮我找充电宝'],
    },
    {
      raw: '北京市朝阳区望京 https://example.invalid/90000000003 SOHO 塔1 1201！帮我找充电宝',
      keep: ['北京市'],
      leak: ['朝阳区', '望京', 'SOHO', '塔1', '1201'],
      candidates: ['https://example.invalid/90000000003'],
      after: ['帮我找充电宝'],
    },
  ]),
)(
  '[AC-B3-05a#48][BR-AI-14][BR-AI-19] 链接 / 口令夹在地址中或在句末前 $shown：地址遮到句末，存储形态保留候选原文',
  async ({ candidates, after, ...address }) => {
    await expectAddressMasked(address);
    await expectAfterKept(address.raw, after);
    const outputs = await threeExits(address.raw);
    for (const exit of ['createAgentRedactor().redact', 'maskForTrace', 'maskForTrace(nested)']) {
      const out = outputs[exit] ?? '';
      for (const candidate of candidates) {
        expect(out, `${exit} 应逐字保留「${candidate}」：${out}`).toContain(candidate);
      }
    }
  },
);
