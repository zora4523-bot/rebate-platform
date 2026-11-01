// B2-15k 错误映射表（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-09（实测前只含文档写明的状态并标未实测）；任务书
// 9.11：列 code,state,meaning,our_handling,source,verified；注出处（文件 + 行），verified 全部 no。状态清单取自
// docs-mirror/wechat-pay/pages/4013070356.txt:471-479、4013070374.txt:603-607；docs-mirror/alipay/app-pay/00dn78.md:57-62、
// 02e7gp.md:250（REFUND_SUCCESS）。
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ROOT, parseCsv } from './kit.ts';

const HEADER = ['code', 'state', 'meaning', 'our_handling', 'source', 'verified'];

function table(name: string): { readonly header: string[]; readonly rows: string[][] } {
  const url = new URL(`specs/${name}`, ROOT);
  expect(existsSync(url), `specs/${name} 必须存在`).toBe(true);
  const [header = [], ...rows] = parseCsv(readFileSync(url, 'utf8'));
  return { header, rows };
}

const COLUMN = Object.fromEntries(HEADER.map((name, index) => [name, index])) as Record<
  'code' | 'state' | 'meaning' | 'our_handling' | 'source' | 'verified',
  number
>;

const WECHAT_STATES = [
  'SUCCESS',
  'REFUND',
  'NOTPAY',
  'CLOSED',
  'REVOKED',
  'USERPAYING',
  'PAYERROR',
  'PROCESSING',
  'ABNORMAL',
];
const ALIPAY_STATES = [
  'WAIT_BUYER_PAY',
  'TRADE_CLOSED',
  'TRADE_SUCCESS',
  'TRADE_FINISHED',
  'REFUND_SUCCESS',
];

const TABLES = [
  [
    'wechat-pay-error-map.csv',
    /^docs-mirror\/wechat-pay\/pages\/\d+\.txt(?::|#L)\d+/,
    WECHAT_STATES,
    ['ORDER_NOT_EXIST'],
  ],
  [
    'alipay-pay-error-map.csv',
    /^docs-mirror\/alipay\/(?:app-pay|guides|api-browser)\/[^:#]+\.md(?::|#L)\d+/,
    ALIPAY_STATES,
    ['ACQ.TRADE_NOT_EXIST'],
  ],
] as const;

it.each(TABLES)('[AC-B2-15k#1801] %s：表头固定，每行六列，每行都有处理方式', (name) => {
  const { header, rows } = table(name);
  expect(header).toEqual(HEADER);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toHaveLength(HEADER.length);
    expect(row[COLUMN.meaning]).not.toBe('');
    expect(row[COLUMN.our_handling]).not.toBe('');
  }
});

it.each(TABLES)('[AC-B2-15k#1802] %s：verified 全部 no（BR-PAY-09：实测前不写成事实）', (name) => {
  const { rows } = table(name);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row[COLUMN.verified]).toBe('no');
});

it.each(TABLES)(
  '[AC-B2-15k#1803] %s：每行注出处（文件 + 行），用 docs-mirror 路径',
  (name, source) => {
    const { rows } = table(name);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row[COLUMN.source]).toMatch(source);
  },
);

it.each(TABLES)(
  '[AC-B2-15k#1804] %s：文档写明的状态都在表里，文档没写的状态一个都没有',
  (name, _source, states) => {
    const { rows } = table(name);
    const listed = new Set(
      rows.map((row) => row[COLUMN.state] ?? '').filter((state) => state !== ''),
    );
    expect([...listed].sort()).toEqual([...states].sort());
  },
);

it.each(TABLES)(
  '[AC-B2-15k#1805] %s：「查无此单」的文档错误码在表里',
  (name, _source, _states, codes) => {
    const { rows } = table(name);
    const listed = new Set(rows.map((row) => row[COLUMN.code]));
    for (const code of codes) expect(listed.has(code)).toBe(true);
  },
);
