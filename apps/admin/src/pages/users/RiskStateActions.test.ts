import { expect, it } from 'vitest';
import { beijingInstant, riskEntries } from './RiskStateActions.tsx';

it('[AC-F1-07jd-ENTRY#1] 正常用户：持两个权限点时有冻结、封禁', () => {
  expect(riskEntries('normal', true, true)).toEqual(['freeze', 'ban']);
});

it('[AC-F1-07jd-ENTRY#2] 已冻结用户：解冻（risk.freeze）与封禁（risk.ban）', () => {
  expect(riskEntries('frozen', true, true)).toEqual(['unfreeze', 'ban']);
  expect(riskEntries('frozen', true, false)).toEqual(['unfreeze']);
  expect(riskEntries('frozen', false, true)).toEqual(['ban']);
});

it('[AC-F1-07jd-ENTRY#3] 已封禁用户只有解封，且只给 risk.ban', () => {
  expect(riskEntries('banned', true, true)).toEqual(['unban']);
  expect(riskEntries('banned', true, false)).toEqual([]);
});

it('[AC-F1-07jd-ENTRY#4] 申诉中或未知状态：没有任何操作', () => {
  expect(riskEntries('appealing', true, true)).toEqual([]);
  expect(riskEntries('unknown_state', true, true)).toEqual([]);
});

it('[AC-F1-07jd-ENTRY#7] 不持 risk.*：没有任何操作', () => {
  for (const state of ['normal', 'frozen', 'banned'])
    expect(riskEntries(state, false, false)).toEqual([]);
});

it('[AC-F1-07jd-WRITE#2] 到期时间按北京时间解释并带 +08:00 发出；格式不对时为 undefined', () => {
  const sent = beijingInstant('2030-12-31T23:59');
  expect(sent).toBe('2030-12-31T23:59:00+08:00');
  expect(Date.parse(sent ?? '')).toBe(Date.UTC(2030, 11, 31, 15, 59));
  expect(beijingInstant('')).toBeUndefined();
  expect(beijingInstant('2030-12-31')).toBeUndefined();
});
