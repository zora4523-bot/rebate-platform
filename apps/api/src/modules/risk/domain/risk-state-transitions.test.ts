// Unit tests of the user_risk_state.state transition table (B1-03h §11 item 4).
import { expect, it } from 'vitest';
import { canTransitionRiskState } from './risk-state-transitions.ts';

it('[B1-03h §11#4] the listed changes, a same-state rewrite and a first row are legal', () => {
  for (const [from, to] of [
    ['normal', 'banned'],
    ['normal', 'frozen'],
    ['frozen', 'normal'],
    ['frozen', 'banned'],
    ['frozen', 'appealing'],
    ['banned', 'normal'],
    ['banned', 'appealing'],
    ['appealing', 'normal'],
    ['appealing', 'banned'],
    ['appealing', 'frozen'],
    ['frozen', 'frozen'],
    [null, 'appealing'],
  ] as const) {
    expect(canTransitionRiskState(from, to)).toBe(true);
  }
});

it('[B1-03h §11#4] unlisted changes and unknown values are illegal', () => {
  for (const [from, to] of [
    ['normal', 'appealing'],
    ['banned', 'frozen'],
    ['normal', 'deleted'],
    ['unknown', 'normal'],
    [null, 'deleted'],
    [undefined, 'normal'],
  ] as const) {
    expect(canTransitionRiskState(from, to)).toBe(false);
  }
});
