// 单元测试：B2-01j buildVouchers 与模板生成器；规则测试在 test/spec/domain/ledger-templates。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildVouchers } from './build-vouchers.ts';
import { renderLedgerTemplates } from './generate-templates.ts';

const header =
  'template_id,ledger_type,sub_type,uniq_key_pattern,line,account_owner,subject,sub_account,sign,amount_ref,note';

it('[AC-B2-01j#u1] templates.gen.ts 与 specs/ledger-templates.csv 逐字一致（--verify 同口径）', () => {
  const csv = readFileSync(new URL('../../../../specs/ledger-templates.csv', import.meta.url));
  const generated = readFileSync(new URL('./templates.gen.ts', import.meta.url), 'utf8');
  expect(renderLedgerTemplates(csv.toString('utf8'))).toBe(generated);
});

it('[AC-B2-01j#u2] 生成器保留引号、逗号、换行与 TBD 原文，表头不符则拒绝', () => {
  const text = `\uFEFF${header}\r\nA,T,,k:{x},1,user,USER_BALANCE,available,debit,a_fen,"x, ""y""\nz"\r\nA,T,,k:{x},2,platform,TBD(08 未定),,credit,a_fen,\r\n`;
  const out = renderLedgerTemplates(text);
  expect(out).toContain(JSON.stringify('x, "y"\nz'));
  expect(out).toContain(JSON.stringify('TBD(08 未定)'));
  expect(renderLedgerTemplates(text)).toBe(out);
  expect(() => renderLedgerTemplates('a,b\n1,2\n')).toThrow(/header/);
});

it('[AC-B2-01j#u3] 冻结凭证：借 available 正、贷 frozen 负，结果冻结不可改', () => {
  const vouchers = buildVouchers('WITHDRAW:FREEZE', {
    user_id: 'u1',
    withdrawal_id: 'w1',
    withdraw_fen: 3000n,
  });
  expect(vouchers).toHaveLength(1);
  expect(vouchers[0]?.uniq_key).toBe('wd:w1:FREEZE');
  expect(vouchers[0]?.entries.map((e) => [e.sub_account, e.amount_fen])).toEqual([
    ['available', 3000n],
    ['frozen', -3000n],
  ]);
  expect(Object.isFrozen(vouchers)).toBe(true);
  expect(Object.isFrozen(vouchers[0]?.entries)).toBe(true);
});

it('[AC-B2-01j#u4] 非字符串模板编号、非对象参数拒绝为 RangeError', () => {
  expect(() => buildVouchers(42 as unknown as string, {})).toThrow(RangeError);
  expect(() => buildVouchers('WITHDRAW:FREEZE', null as unknown as Record<string, bigint>)).toThrow(
    RangeError,
  );
  expect(() => buildVouchers('CREDIT:PLATFORM', { order_key: 'taobao:1' })).toThrow(RangeError);
});
