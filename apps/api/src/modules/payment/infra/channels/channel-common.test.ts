// B2-15k: implementer's unit tests of the shared channel helpers (ported where they still apply from
// task/PAY-01; the acceptance tests are test/spec/payment/channels/**). No database, no network.
import { describe, expect, it } from 'vitest';
import {
  alipayDateTime,
  channelErrorReason,
  echoConflicts,
  fenFromJson,
  notifyAddress,
  parseJsonObject,
  rfc3339China,
  transportFailureReason,
  unverifiedErrorReason,
} from './channel-common.ts';
import { PayResponseTooLarge } from './transport.ts';

const PHONE = '13800138000';

describe('channel-common', () => {
  it('[AC-B2-15k-U#1] an error code prints only as a known constant', () => {
    expect(channelErrorReason('SYSTEM_ERROR')).toBe('channel_error:SYSTEM_ERROR');
    expect(channelErrorReason(PHONE)).toBe('channel_error:other');
    expect(channelErrorReason(42, null)).toBe('channel_error:other');
    expect(channelErrorReason(`X_${PHONE}`, '40004')).toBe('channel_error:40004');
    expect(unverifiedErrorReason('ACQ.SYSTEM_ERROR', 'bad_status')).toBe(
      'unverified_error:ACQ.SYSTEM_ERROR',
    );
    expect(unverifiedErrorReason(PHONE, 'bad_status')).toBe('bad_status');
  });

  it('[AC-B2-15k-U#2] an exception becomes a fixed category, its name never leaves', () => {
    const leaky = Object.assign(new Error(PHONE), { name: `Customer ${PHONE}` });
    expect(transportFailureReason(leaky)).toBe('transport_error');
    expect(transportFailureReason('text')).toBe('transport_error');
    expect(transportFailureReason(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(
      'timeout',
    );
    expect(transportFailureReason(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(
      'timeout',
    );
    expect(transportFailureReason(new PayResponseTooLarge())).toBe('response_too_large');
  });

  it('[AC-B2-15k-U#3] only a JSON object parses', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    for (const text of ['[]', 'null', '"x"', '1', '{not json', '']) {
      expect(parseJsonObject(text)).toBeNull();
    }
  });

  it('[AC-B2-15k-U#4] a carried field must be the request value; absent or unset fields do not conflict', () => {
    expect(echoConflicts({ out_trade_no: 'P1' }, { out_trade_no: 'P1' })).toBe(false);
    expect(echoConflicts({}, { out_trade_no: 'P1' })).toBe(false);
    expect(echoConflicts({ out_trade_no: 'P2' }, { out_trade_no: 'P1' })).toBe(true);
    expect(echoConflicts({ out_trade_no: 42 }, { out_trade_no: 'P1' })).toBe(true);
    expect(echoConflicts({ out_trade_no: 'P2' }, { out_trade_no: null })).toBe(false);
    expect(echoConflicts({ out_trade_no: 'P2' }, { out_trade_no: undefined })).toBe(false);
  });

  it('[AC-B2-15k-U#5] fen from JSON: positive safe integers only', () => {
    expect(fenFromJson(1)).toBe(1n);
    expect(fenFromJson(2147483648)).toBe(2147483648n);
    for (const value of [0, -1, 1.5, '100', null, undefined, 2 ** 53, Number.NaN, {}]) {
      expect(fenFromJson(value)).toBeNull();
    }
  });

  it('[AC-B2-15k-U#6] +08:00 formats drop the milliseconds and leave the given instant alone', () => {
    const at = new Date('2026-11-01T15:59:59.999Z');
    expect(alipayDateTime(at)).toBe('2026-11-01 23:59:59');
    expect(rfc3339China(at)).toBe('2026-11-01T23:59:59+08:00');
    expect(at.toISOString()).toBe('2026-11-01T15:59:59.999Z');
    expect(() => rfc3339China(new Date('not a date'))).toThrow(RangeError);
  });

  it('[AC-B2-15k-U#7] the notification address takes the origin of the base and the path of the route', () => {
    expect(notifyAddress('/notify/pay/wechat', 'https://pay.example.test/ignored')).toBe(
      'https://pay.example.test/notify/pay/wechat',
    );
    expect(notifyAddress('/notify/pay/wechat', 'not a url')).toBeNull();
  });
});
