import { expect, it } from 'vitest';
import { checkJumpTipBody, tipsData } from './tips.ts';

it('[AC-B1-02s] jump_tip body: a PlatformCode platform passes', () => {
  expect(checkJumpTipBody({ platform: 'taobao' })).toEqual({ ok: true, platform: 'taobao' });
  expect(checkJumpTipBody({ platform: 'suning' })).toEqual({ ok: true, platform: 'suning' });
});

it('[AC-B1-02s] jump_tip body: a missing body or platform names platform', () => {
  expect(checkJumpTipBody(undefined)).toEqual({ ok: false, fields: ['platform'] });
  expect(checkJumpTipBody(null)).toEqual({ ok: false, fields: ['platform'] });
  expect(checkJumpTipBody({})).toEqual({ ok: false, fields: ['platform'] });
});

it('[AC-B1-02s] jump_tip body: a platform outside PlatformCode names platform', () => {
  for (const platform of ['not-a-platform', 'ios', '', null, 1, ['taobao']]) {
    expect(checkJumpTipBody({ platform })).toEqual({ ok: false, fields: ['platform'] });
  }
});

it('[AC-B1-02s] jump_tip body: unknown keys are refused (additionalProperties false)', () => {
  expect(checkJumpTipBody({ platform: 'jd', extra: 1 })).toEqual({ ok: false, fields: ['extra'] });
  expect(checkJumpTipBody({ extra: 1 })).toEqual({ ok: false, fields: ['platform', 'extra'] });
});

it('[AC-B1-02s] jump_tip body: a body that is not an object names body', () => {
  for (const body of ['taobao', 1, true, ['taobao']]) {
    expect(checkJumpTipBody(body)).toEqual({ ok: false, fields: ['body'] });
  }
});

it('[AC-B1-02s] tips data: no rows is an empty platform map and null', () => {
  expect(tipsData([])).toEqual({ jump_tip: {}, inviter_before_buy: null });
});

it('[AC-B1-02s] tips data: jump_tip per read platform, inviter_before_buy not per platform', () => {
  const first = new Date('2031-05-06T07:08:09.123Z');
  const second = new Date('2031-05-06T07:09:00.000Z');
  expect(
    tipsData([
      { tip_key: 'jump_tip', platform: 'taobao', read_at: first },
      { tip_key: 'jump_tip', platform: 'jd', read_at: second },
      { tip_key: 'inviter_before_buy', platform: '', read_at: second },
    ]),
  ).toEqual({
    jump_tip: { taobao: first.toISOString(), jd: second.toISOString() },
    inviter_before_buy: second.toISOString(),
  });
});

it('[AC-B1-02s] tips data: rows outside the contract are left out', () => {
  const at = new Date('2031-05-06T07:08:09.123Z');
  expect(
    tipsData([
      { tip_key: 'jump_tip', platform: '', read_at: at },
      { tip_key: 'jump_tip', platform: 'unknown', read_at: at },
      { tip_key: 'inviter_before_buy', platform: 'taobao', read_at: at },
      { tip_key: 'other', platform: 'taobao', read_at: at },
    ]),
  ).toEqual({ jump_tip: {}, inviter_before_buy: null });
});
