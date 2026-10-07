import { expect, it } from 'vitest';
import {
  currentStates,
  loginMergeCopies,
  normalizeInviteCode,
  type ConsentState,
} from './login.ts';

const NOW = Date.parse('2026-10-08T04:00:00.000Z');
let next = 0;
function record(type: string, version: number, at: number, accepted = true): ConsentState {
  next += 1;
  return {
    id: BigInt(next),
    type,
    version,
    accepted,
    client_at: new Date(NOW + at - 500),
    server_at: new Date(NOW + at),
  };
}

it('[BR-INV-02] invite codes are NFKC-normalised, stripped of whitespace and zero-width characters, upper-cased; empty means none', () => {
  expect(normalizeInviteCode(' k7q2mz ')).toBe('K7Q2MZ');
  expect(normalizeInviteCode('ｋ７Ｑ\u200B2 mz\u3000')).toBe('K7Q2MZ');
  expect(normalizeInviteCode('bad-code')).toBe('BAD-CODE');
  for (const empty of [undefined, '', '   ', '\u3000', '\u200B\uFEFF'])
    expect(normalizeInviteCode(empty)).toBeUndefined();
});

it('[BR-ID-12] the current state of a type is its latest server_at, ties go to the later id', () => {
  const older = record('privacy', 20, -5000);
  const latest = record('privacy', 2, -1000);
  const tieFirst = record('agreement', 1, -1000);
  const tieSecond = record('agreement', 2, -1000);
  const states = currentStates([latest, older, tieSecond, tieFirst]);
  expect(states.get('privacy')).toBe(latest);
  expect(states.get('agreement')).toBe(tieSecond);
});

it('[BR-ID-12] login_merge copies under exactly the three conditions', () => {
  const cases: [number | null, number, number, number, boolean][] = [
    // user version, user at, device version, device at, copied
    [null, -1000, 1, -3000, true],
    [2, -1000, 3, -3000, true],
    [3, -3000, 3, -1000, true],
    [3, -3000, 2, -1000, false],
    [3, -1000, 3, -3000, false],
    [3, -1000, 3, -1000, false],
  ];
  for (const [userVersion, userAt, deviceVersion, deviceAt, copied] of cases) {
    const device = record('personalization', deviceVersion, deviceAt, false);
    const user = userVersion === null ? [] : [record('personalization', userVersion, userAt)];
    expect(loginMergeCopies([device], user)).toEqual(copied ? [device] : []);
  }
});

it('[BR-ID-12] ai_third_party and labor_agreement never take part; only current device states are copied', () => {
  const current = record('id_verification', 2, -1000, false);
  const copies = loginMergeCopies(
    [
      record('ai_third_party', 9, -1000),
      record('labor_agreement', 4, -1000),
      record('id_verification', 20, -5000),
      current,
    ],
    [record('id_verification', 1, -2000), record('id_verification', 30, -6000)],
  );
  expect(copies).toEqual([current]);
});
