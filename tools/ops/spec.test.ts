import { expect, it } from 'vitest';
import {
  extractDetail,
  findRule,
  findRuleInText,
  oneHopRefs,
  ruleHash,
  splitTableRow,
  taskIdKnown,
} from './spec.ts';
import type { Rule } from './spec.ts';
import { CLI_TIMEOUT, memorySpec } from './test-helpers.ts';

const CALC = '规划/08_业务规则/05_CALC_返利计算与分账.md';

function synthetic(
  opts: { status?: string; body?: string; impact?: string; detail?: string } = {},
): string {
  const status = opts.status ?? '默认假设';
  return [
    '# demo',
    '',
    '| 编号 | 规则 | 状态 | 影响面 |',
    '| --- | --- | --- | --- |',
    `| BR-DEMO-01 | **标题**<br>${opts.body ?? '间隔 watch.&lt;hot\\|default\\|cold>.minutes 必须为正'} | ${status} | ${opts.impact ?? 'packages/demo'} |`,
    '| BR-DEMO-02 | **另一条**<br>见 BR-DEMO-01 | 已确认 | — |',
    '',
    '### 1.2 细则',
    '',
    '#### BR-DEMO-01 细则 · 标题',
    '',
    `- 状态：${status}`,
    '- 默认值：无',
    '',
    opts.detail ?? '- 例：正则 ^(a\\|b)$；另见 BR-DEMO-02、03 与 BR-OTHER-10～12、BR-FUND。',
    '',
    '#### BR-DEMO-02 细则 · 另一条',
    '',
    '- 状态：已确认',
    '',
    '### 1.3 未决问题',
    '',
  ].join('\n');
}

function demoRule(opts: Parameters<typeof synthetic>[0] = {}): Rule {
  const rule = findRuleInText(synthetic(opts), 'BR-DEMO-01', 'demo.md');
  if (!rule) throw new Error('fixture is broken');
  return rule;
}

it('splits table rows and keeps escaped pipes inside their cell', () => {
  expect(splitTableRow('| a | b \\| c | d |')).toEqual([' a ', ' b \\| c ', ' d ']);
  expect(splitTableRow('| a | |')).toEqual([' a ', ' ']);
  expect(splitTableRow('not a row')).toBeNull();
  expect(splitTableRow('| a | b \\|')).toBeNull();
});

it('reads a rule whose cell contains escaped pipes and drops the last column', () => {
  const rule = demoRule();
  expect(rule.status).toBe('默认假设');
  expect(rule.rowText).toBe(
    '| BR-DEMO-01 | **标题**<br>间隔 watch.&lt;hot\\|default\\|cold>.minutes 必须为正 | 默认假设 |',
  );
  expect(rule.rowText).not.toContain('packages/demo');
});

it('cuts the detail section at the next heading', () => {
  const detail = extractDetail(synthetic(), 'BR-DEMO-01');
  expect(detail.startsWith('#### BR-DEMO-01 细则 · 标题')).toBe(true);
  expect(detail).toContain('正则 ^(a\\|b)$');
  expect(detail).not.toContain('BR-DEMO-02 细则');
  expect(extractDetail(synthetic(), 'BR-DEMO-02')).not.toContain('未决问题');
  expect(extractDetail(synthetic(), 'BR-DEMO-09')).toBe('');
});

it('reports a row that was cut wrong by an unescaped pipe', () => {
  const text = synthetic({ body: 'a | b' });
  expect(() => findRuleInText(text, 'BR-DEMO-01', 'demo.md')).toThrow(/5 cells, expected 4/);
});

it('hashes the body only: whitespace, status and 影响面 do not matter', () => {
  const base = ruleHash(demoRule());
  expect(base).toMatch(/^[0-9a-f]{12}$/);
  expect(ruleHash(demoRule({ status: '已确认' }))).toBe(base);
  expect(ruleHash(demoRule({ impact: 'apps/api' }))).toBe(base);
  const spaced = { ...demoRule(), detailText: demoRule().detailText.replace(/\n/g, '\n\n  ') };
  expect(ruleHash(spaced)).toBe(base);
  expect(ruleHash(demoRule({ body: '间隔必须为正' }))).not.toBe(base);
  expect(ruleHash(demoRule({ detail: '- 例：改过的细则' }))).not.toBe(base);
});

it('finds one-hop references including the short forms', () => {
  expect(oneHopRefs(demoRule())).toEqual([
    'BR-DEMO-02',
    'BR-DEMO-03',
    'BR-OTHER-10',
    'BR-OTHER-11',
    'BR-OTHER-12',
  ]);
  const prose = demoRule({ detail: '- 见 BR-DEMO-02、3 个例子，日期 BR-DEMO-04、2026-10-01' });
  expect(oneHopRefs(prose)).toEqual(['BR-DEMO-02', 'BR-DEMO-04']);
});

it('resolves rules through an injected source and rejects unknown ids', () => {
  const spec = memorySpec({ '规划/08_业务规则/01_DEMO.md': synthetic() });
  expect(findRule('BR-DEMO-02', spec).status).toBe('已确认');
  expect(() => findRule('BR-DEMO-09', spec)).toThrow(/not found/);
  expect(() => findRule('TODO-1', spec)).toThrow(/unsupported reference/);
});

// The cases below read the real planning repository at SPEC_REF.

it(
  'reads BR-CALC-01 from the planning repository at SPEC_REF',
  () => {
    const rule = findRule('BR-CALC-01');
    expect(rule.file).toBe(CALC);
    expect(rule.status).toBe('已确认');
    expect(rule.rowText.startsWith('| BR-CALC-01 | **金额与比例的数据类型**<br>')).toBe(true);
    expect(rule.rowText.endsWith('| 已确认 |')).toBe(true);
    // The 影响面 column is gone.
    expect(rule.rowText).not.toContain('lint 规则');
    expect(rule.detailText.startsWith('#### BR-CALC-01 细则 · 金额与比例的数据类型')).toBe(true);
    expect(rule.detailText).toContain('mulDivFloor(amount_fen, ratio_bp, 10000n)');
    expect(rule.detailText).not.toContain('BR-CALC-02 细则');
    expect(oneHopRefs(rule)).toEqual(['BR-CALC-02', 'BR-CALC-26']);
  },
  CLI_TIMEOUT,
);

it(
  'reads BR-CALC-08 and BR-CALC-21 with their detail sections',
  () => {
    const rounding = findRule('BR-CALC-08');
    expect(rounding.rowText).toContain('**舍入与尾差归属**');
    expect(rounding.detailText).toContain('B=1235、5000/1000');
    // `BR-FUND` without a number is a topic, not a rule.
    expect(oneHopRefs(rounding)).toEqual(['BR-CALC-03']);

    const invariants = findRule('BR-CALC-21');
    expect(invariants.detailText).toContain('csv 至少覆盖');
    expect(invariants.detailText).not.toContain('#### BR-CALC-22');
    expect(oneHopRefs(invariants)).toContain('BR-FUND-19');
    expect(ruleHash(invariants)).toMatch(/^[0-9a-f]{12}$/);
  },
  CLI_TIMEOUT,
);

it(
  'parses the real rows that contain escaped pipes',
  () => {
    const ids = [
      'BR-PROD-06',
      'BR-PRICE-13',
      'BR-FUND-04',
      'BR-FUND-12',
      'BR-WDR-07',
      'BR-WATCH-07',
      'BR-WATCH-29',
      'BR-ID-09',
      'BR-INV-06',
      'BR-TEXT-03',
      'BR-TEXT-20',
    ];
    const rows = ids.map((id) => findRule(id).rowText);
    expect(rows.every((row) => splitTableRow(row)?.length === 3)).toBe(true);
    expect(findRule('BR-WATCH-07').rowText).toContain('hot\\|default\\|cold');
  },
  CLI_TIMEOUT,
);

it(
  'resolves acceptance ids and task ids at SPEC_REF',
  () => {
    const stage = findRule('AC-S1-01-TB');
    expect(stage.file).toBe('规划/10_首个完整流程验收用例.md');
    expect(stage.rowText).toContain('搜索后买到带返利的淘宝商品');
    const epic = findRule('AC-ACC-01');
    expect(epic.file).toBe('规划/01_需求规划.md');
    expect(epic.rowText).toContain('F-ACC-01');
    expect(() => findRule('BR-CALC-99')).toThrow(/not found/);

    expect(taskIdKnown('B2-01')).toBe(true);
    expect(taskIdKnown('ZZ-99')).toBe(false);
    // Mentioned inside "BR-CALC-01", but not a task row.
    expect(taskIdKnown('CALC-01')).toBe(false);
  },
  CLI_TIMEOUT,
);
