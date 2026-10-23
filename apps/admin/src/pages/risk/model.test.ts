import { expect, it } from 'vitest';
import { AdminApiError } from '../../providers/data/index.ts';
import {
  beijingTime,
  changeOf,
  changeRequest,
  configItemTarget,
  targetOf,
  writeOutcomeUnknown,
  type RiskRule,
} from './model.ts';

const rule: RiskRule = {
  rule_id: 'R1',
  scene: 'register',
  name: '规则一',
  risk_action: 'block',
  status: 'enabled',
  threshold_keys: [],
  version: 3,
  updated_at: '2026-10-22T19:04:05Z',
};

it('[F1-10fa] update time is Beijing date and minute whatever the input offset', () => {
  expect(beijingTime('2026-10-22T19:04:05Z')).toBe('2026-10-23 03:04');
  expect(beijingTime('2026-10-23T12:34:56+08:00')).toBe('2026-10-23 12:34');
  expect(beijingTime('not a time')).toBe('not a time');
});

it('[F1-10fa] an enabled rule offers disable, any other enable, and each leads to its status', () => {
  expect(changeOf(rule)).toBe('disable');
  expect(changeOf({ ...rule, status: 'disabled' })).toBe('enable');
  expect(targetOf('enable')).toBe('enabled');
  expect(targetOf('disable')).toBe('disabled');
});

it('[F1-10fa] the body carries the listed version and the reason only when one was typed', () => {
  expect(changeRequest(rule, '')).toEqual({ expected_version: 3 });
  expect(changeRequest(rule, '   ')).toEqual({ expected_version: 3 });
  expect(changeRequest(rule, '复查')).toEqual({ expected_version: 3, reason: '复查' });
});

it('[F1-10fa] a threshold key opens the config center with the key in the address', () => {
  const target = configItemTarget('risk.a_b&c');
  expect(target.pathname).toBe('/config');
  expect(new URLSearchParams(target.search).get('item')).toBe('risk.a_b&c');
});

it('[F1-10fa] a write is unknown only when no refusal was read back', () => {
  expect(writeOutcomeUnknown(new TypeError('offline'))).toBe(true);
  const refusal = new AdminApiError({
    code: 20902,
    msg: '',
    data: null,
    httpStatus: 400,
    kind: 'api',
  });
  expect(writeOutcomeUnknown(refusal)).toBe(false);
  const server = new AdminApiError({
    code: 50000,
    msg: '',
    data: null,
    httpStatus: 500,
    kind: 'api',
  });
  expect(writeOutcomeUnknown(server)).toBe(true);
});
