// B1-03ze: the two pure rules behind the console writes (CT-24r adminResolveAppeal permission and
// step-up, 编排裁定 D10-154; the note / reason of resolve and register: 1–200 characters after
// trimming surrounding whitespace, else 20001).
import { expect, it } from 'vitest';
import {
  appealConsoleText,
  appealResolveRequirement,
} from '../../../../apps/api/src/modules/risk/application/admin-appeals-write.ts';

const NONE = { permission: null, step_up: null };

it.each([
  [{ target_type: 'account', prev_risk_state: 'banned', cause: null }, NONE],
  [{ target_type: 'account', prev_risk_state: 'frozen', cause: null }, NONE],
  [{ target_type: 'blocked_request', prev_risk_state: null, cause: 'blocklist' }, NONE],
  [{ target_type: 'blocked_request', prev_risk_state: null, cause: 'rule' }, NONE],
  [{ target_type: 'order', prev_risk_state: null, cause: null }, NONE],
] as const)('[AC-B1-03ze#3] 维持 %j 只需 risk.appeal，无 step-up', (input, expected) => {
  expect(appealResolveRequirement({ decision: 'upheld', ...input })).toEqual(expected);
});

it.each([
  [
    { target_type: 'account', prev_risk_state: 'banned', cause: null },
    { permission: 'risk.ban', step_up: 'totp' },
  ],
  [
    { target_type: 'account', prev_risk_state: 'frozen', cause: null },
    { permission: 'risk.freeze', step_up: 'totp' },
  ],
  [
    { target_type: 'blocked_request', prev_risk_state: null, cause: 'blocklist' },
    { permission: 'risk.blocklist', step_up: 'totp' },
  ],
  [{ target_type: 'blocked_request', prev_risk_state: null, cause: 'rule' }, NONE],
  [{ target_type: 'order', prev_risk_state: null, cause: null }, NONE],
] as const)('[AC-B1-03ze#4] 撤销 %j → %j', (input, expected) => {
  expect(appealResolveRequirement({ decision: 'revoked', ...input })).toEqual(expected);
});

it.each([
  ['因', '因'],
  ['  核实属实  ', '核实属实'],
  ['\t\n核实\n', '核实'],
  ['因'.repeat(200), '因'.repeat(200)],
  [`  ${'因'.repeat(200)}  `, '因'.repeat(200)],
])('[AC-B1-03ze#5] 说明 %j 去首尾空白后 1–200 字有效', (input, expected) => {
  expect(appealConsoleText(input)).toBe(expected);
});

it.each(['', '   ', '\t\n', '因'.repeat(201), ` ${'因'.repeat(201)} `])(
  '[AC-B1-03ze#6] 说明 %j 为空白或超过 200 字无效',
  (input) => {
    expect(appealConsoleText(input)).toBeNull();
  },
);

// One-element rows: an array item of it.each would otherwise be spread into arguments.
it.each<[unknown]>([[undefined], [null], [0], [1], [true], [['核实']], [{ note: '核实' }]])(
  '[AC-B1-03ze#7] 非字符串说明 %j 无效',
  (input) => {
    expect(appealConsoleText(input)).toBeNull();
  },
);
