import { expect, it } from 'vitest';
import {
  createAgentRedactor,
  maskForTrace,
  redactForModel,
} from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';

// BR-AI-14 收货地址 / BR-AI-19 落库前脱敏，负责人 2026-10-15 第二次额外口径的补充（同日负责人选「补繁体后落地」）：
// 繁体写法的行政区与门牌标记（區、縣、鎮、鄉、號、樓、棟 …）与简体同样是锚点，其后遮到句末；写了的省市保留用户原文。
// 只断言详细信息三个出口都不出现、写了的省市原样保留、再脱敏不变；不断言掩码样式，多遮可接受。
// 全部为合成输入：行政区与路名是公开地名，楼栋房号为虚构组合，不对应任何个人。

interface AddressCase {
  raw: string;
  /** 必须保留的省 / 市原文；没写省市或前面带表单标签时为空（标签行被多遮可以接受）。 */
  keep: readonly string[];
  /** 详细地址片段，三个出口都不得出现。 */
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

const TRADITIONAL: readonly AddressCase[] = [
  { raw: '南山區科技園A棟1201室', keep: [], leak: ['A棟1201', '1201室'] },
  { raw: '屏東縣潮州鎮合成路8號3樓', keep: [], leak: ['合成路8號', '8號3樓', '3樓'] },
  { raw: '香港新界沙田區合成道8號12樓B室', keep: [], leak: ['合成道8號', '12樓B室'] },
  { raw: '我住在湾仔區合成道8号', keep: [], leak: ['合成道8号'] },
  { raw: '寄到古城鎮王莊村3組', keep: [], leak: ['王莊村3組', '3組'] },
  { raw: '黃家鄉合成村3組，謝謝', keep: [], leak: ['合成村3組'] },
  {
    raw: '廣東省深圳市南山區科技園A棟1201室',
    keep: ['廣東省', '深圳市'],
    leak: ['A棟1201', '科技園A棟'],
  },
  { raw: '臺北市大安區合成路一段8號5樓', keep: ['臺北市'], leak: ['合成路一段8號', '8號5樓'] },
  { raw: '香港九龍旺角彌敦道8號3樓', keep: ['香港'], leak: ['彌敦道8號', '8號3樓'] },
  { raw: '澳門氹仔合成街8號3樓', keep: ['澳門'], leak: ['合成街8號', '8號3樓'] },
  { raw: '寄到香港九龙旺角合成道8号3楼', keep: ['香港'], leak: ['合成道8号', '8号3楼'] },
  { raw: '收貨地址為合成路8號5樓', keep: [], leak: ['合成路8號', '8號5樓'] },
  { raw: '房號為1201，樓棟號為3棟', keep: [], leak: ['1201', '3棟'] },
  { raw: '詳細地址：合成路8號5樓', keep: [], leak: ['合成路8號', '8號5樓'] },
  { raw: '鎮江市合成路8號3樓', keep: ['鎮江市'], leak: ['合成路8號', '8號3樓'] },
  { raw: '寄到镇江市合成路8号3楼', keep: [], leak: ['合成路8号', '8号3楼'] },
  { raw: '收件人王小明\n新北市板橋區合成街8號', keep: ['新北市'], leak: ['合成街8號'] },
];

it.each(shown(TRADITIONAL))(
  '[AC-B3-05a#49][BR-AI-14][BR-AI-19] 繁体行政区与门牌标记：$shown 三出口不留详细地址，写了的省市保留原文',
  async (item) => {
    await expectAddressMasked(item);
  },
);
