import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('[AC-B2-01l#10] 人读规格集中标注代理起草待财务确认、逐项依据及注销改派未决边界', () => {
  const markdown = readFileSync(new URL('../../../specs/ledger-rules.md', import.meta.url), 'utf8');
  const heading = /^(#{1,6}) [^\n]*代理起草[^\n]*待财务确认[^\n]*\n/m.exec(markdown);
  expect(heading, '本轮裁定须有独立起草说明节').not.toBeNull();
  const body = markdown.slice(heading!.index + heading![0].length);
  const end = body.search(new RegExp(`^#{1,${heading![1]!.length}} `, 'm'));
  const section = end < 0 ? body : body.slice(0, end);
  for (const term of [
    'BR-FUND-04',
    'BR-FUND-05',
    'BR-FUND-15',
    'BR-FUND-16',
    'BR-FUND-20',
    'BR-WDR-07',
    'BR-WDR-09',
    'BR-FUND-24',
    'BR-INV-22',
    '20261018-账务模板待定项',
    'platform_credit_fen',
    'pending_credit_fen',
    'receipt_fen',
    'net_fen',
    'tax_fen',
    'available',
    'REBATE_CREDIT',
    'REASSIGN_REV',
    'REWARD',
    'P1',
    '白名单',
    'COMMISSION_REVENUE',
    'UNION_RECEIVABLE',
    'BAD_DEBT',
    'MKT_EXPENSE',
  ])
    expect(section, term).toContain(term);
  expect(section).toMatch(/(开立|开立时)[^\n]*(类型|sub_type)/);
  expect(section).toMatch(/(分组|类型组)/);
  expect(section).toMatch(/(净额[^\n]*(为零|为 0)|净额[^\n]*0)/);
  expect(section).toMatch(/注销[^\n]*(待负责人|未决|待.*决定)/);
  expect(section).toMatch(/(不执行|不提交)/);
});
