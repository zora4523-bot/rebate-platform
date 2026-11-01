// B1-05w (编排 12:06 ③): getProduct declares the 50401 its fallbacks end in, and contracts/
// error-codes.yaml carries 50301 as 08 §13.11 has it, with http, retry and data untouched. The file
// keeps one flat scalar per line, so the entry is read as text.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);

/** 08 §13.11 row 50301, the column of its meaning, as it stands at SPEC_REF. */
const MEANING_50301 =
  '依赖的外部服务处于不可用状态：① 该平台转链暂停——`convert.enabled.<platform>` 关闭（运营维护、熔断触发的关闭，或平台未开放），或该平台转链依赖的站长授权已失效（BR-ID-24，按 maintenance）（`data.platform`、`data.reason` ∈ {maintenance, not_launched}，取值见 规划/04 §10.2 `convert.off_reason.<platform>`；熔断触发的关闭按 maintenance）；② 实名核验服务不可用或返回错误（App 自助实名与后台实名更正，BR-ID-25；App 自助实名在还没接入核验服务时同样返回本码）；③ 绑定银行卡收款账号时卡 BIN 来源或银行卡核验服务不可用（BR-WDR-02）；④ 短信服务商拒收（含签名或模板 CODE 不对）或出错（后台短信模板的登记与测试发送，BR-TEXT-20 细则「短信渠道登记与后台渠道开关」，编排裁定 D10-335 ③）。②～④ 不带 `data.platform`、`data.reason`。调用时的暂时失败不用本码：单次复核或转链失败、联盟网关的熔断返回 50303（BR-PRICE-13；2026-10-06 同步，12 §9 X-05；转链与详情各接口的分法见 BR-PROD-05 细则「结果分类」③）；其他依赖的超时、限流、熔断或结果未知返回 50401。有专用码的依赖不论不可用还是暂时失败都照用专用码（AI 50302、搜索 50304、第三方登录 50305、支付渠道 50306）';
const SOURCES_50301 = [
  'BR-TEXT-14',
  'BR-PRICE-13',
  'BR-PROD-05',
  'BR-PROD-10',
  'BR-ID-24',
  'BR-ID-25',
  'BR-WDR-02',
  'BR-TEXT-20',
];

interface Operation {
  readonly operationId: string;
  readonly description: string;
  readonly 'x-error-codes': number[];
}

async function getProductOperation(): Promise<Operation> {
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ paths: Record<string, Record<string, Operation>> }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const operation = doc.paths['/v1/products/{product_key}']?.['get'];
  expect(operation?.operationId).toBe('getProduct');
  return operation!;
}

/** The lines of one code's entry. */
function errorEntry(code: number): string {
  const text = readFileSync(new URL('contracts/error-codes.yaml', root), 'utf8');
  const start = text.indexOf(`  - code: ${String(code)}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n  - code: ', start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

function scalar(entry: string, name: string): string | undefined {
  const line = entry.split('\n').find((row) => row.startsWith(`    ${name}: `));
  return line?.slice(`    ${name}: `.length).replace(/^(['"])(.*)\1$/u, '$2');
}

it('[B1-05w#64][BR-PRICE-11] getProduct 的 x-error-codes 补 50401，原有的 30141、30143 还在', async () => {
  const codes = (await getProductOperation())['x-error-codes'];

  expect(codes).toContain(50401);
  expect(codes).toEqual(expect.arrayContaining([30141, 30143]));
});

it('[B1-05w#65][BR-PRICE-11] getProduct 的描述写明 50401：旧缓存与商品池降级都不可用时', async () => {
  const { description } = await getProductOperation();

  expect(description).toContain('50401');
  expect(description).toMatch(/cache|缓存/iu);
  expect(description).toMatch(/pool|商品池/iu);
});

it('[B1-05w#66][BR-PROD-05] error-codes.yaml 50301 的 meaning 与 sources 按 08 §13.11 同步，http、retry、data 不变', () => {
  const entry = errorEntry(50301);

  expect(scalar(entry, 'meaning')).toBe(MEANING_50301);
  expect(scalar(entry, 'sources')).toBe(`[${SOURCES_50301.join(', ')}]`);
  expect(scalar(entry, 'http')).toBe('503');
  expect(scalar(entry, 'retry')).toBe('maintenance：稍后；not_launched：否');
  expect(scalar(entry, 'retry_kind')).toBe('later');
  expect(entry).toContain(
    [
      '    retry_kind_by_reason:',
      '      maintenance: later',
      '      not_launched: never',
      '    data:',
      '      platform: ~',
      '      reason: [maintenance, not_launched]',
    ].join('\n'),
  );
});
