// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { NO, VIEW_GRANTS, createServer, samples } from './fixtures.ts';
import { FLOW_TIMEOUT, mount, openList, rowOf, squash, textOf } from './helpers.ts';

// The console dictionary without any key (as in [AC-F1-08e-DICT#1] / [AC-F1-10fa-DICT#1]):
// every name falls back to its code.
vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

/** What a missing name must not turn into: undefined or a dictionary key path. */
const NOT_A_NAME =
  /undefined|admin_dict|withdrawal_status\.|withdrawals\.(?:review_mode|risk_flags|auto_decision)/;

it(
  '[AC-F1-08a-DICT#1] 后台字典缺键时状态、风险标签、转人工原因显示原编码（如 PENDING_REVIEW / first_withdrawal / max_amount），不显示 undefined、空白或键路径',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await openList(server, NO.pending);
    for (const item of samples()) {
      const number = item.out_biz_no;
      const text = squash(rowOf(number).textContent);
      expect(text, `${number} status`).toContain(item.status);
      for (const flag of item.risk_flags) expect(text, `${number} risk flag`).toContain(flag.code);
      expect(textOf(rowOf(number)), `${number} row`).not.toMatch(NOT_A_NAME);
    }
    expect(squash(rowOf(NO.pending).textContent), 'condition code').toContain('max_amount');
    expect(squash(rowOf(NO.rejected).textContent), 'condition code').toContain('same_day');
  },
  FLOW_TIMEOUT,
);
