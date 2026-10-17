import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { classifyBuyType, isKnownPidScene, parseAttrCode, resolveBinding } from './attribution.ts';
import { orderCanonicalJson, orderContentHash } from './content-hash.ts';
import { planImportState } from './import-state.ts';

const at = (iso: string) => new FixedClock(iso).now();
const none = { relation_id: null, sub_union_id: null, custom_parameters: null };

describe('attribution helpers', () => {
  it('[AC-B1-08h#U1] 京东只看 sub_union_id，拼多多只看 custom_parameters', () => {
    expect(parseAttrCode('jd', { ...none, sub_union_id: 'n_0a1b2c3d_x9' })).toBe('0a1b2c3d');
    expect(
      parseAttrCode('jd', { ...none, custom_parameters: '{"app":"n","uid":"0a1b2c3d"}' }),
    ).toBe(null);
    expect(
      parseAttrCode('pdd', { ...none, custom_parameters: '{"app":"n","uid":"0a1b2c3d"}' }),
    ).toBe('0a1b2c3d');
    expect(parseAttrCode('pdd', { ...none, sub_union_id: 'n_0a1b2c3d' })).toBe(null);
  });

  it('[AC-B1-08h#U2] 绑定区间：未来绑定、到期绑定不参与，多个同用户归属', () => {
    const attrAt = at('2026-10-15T16:00:00.000Z');
    const row = (user_id: string, bound: string, end: string | null) => ({
      user_id,
      bound_at: at(bound),
      released_at: null,
      cooldown_until: end === null ? null : at(end),
    });
    expect(
      resolveBinding(
        [
          row('u1', '2026-10-01T00:00:00.000Z', null),
          row('u2', '2026-10-16T00:00:00.000Z', null),
          row('u3', '2026-10-01T00:00:00.000Z', '2026-10-15T16:00:00.000Z'),
        ],
        attrAt,
      ),
    ).toEqual({ kind: 'matched', user_id: 'u1' });
    expect(resolveBinding([], attrAt)).toEqual({ kind: 'miss', user_id: null });
  });

  it('[AC-B1-08h#U3] buy_type：未写明的 pid_scene 落 self / fallback', () => {
    expect(isKnownPidScene('query')).toBe(false);
    expect(isKnownPidScene('fallback')).toBe(true);
    expect(classifyBuyType('pdd', 'unknown', '{"sc":"share"}')).toEqual({
      buy_type: 'self',
      scene_basis: 'fallback',
    });
    expect(classifyBuyType('pdd', 'fallback', '{"sc":"agent"}')).toEqual({
      buy_type: 'self',
      scene_basis: 'param',
    });
  });

  it('[AC-B1-08h#U4] content_hash 规范 JSON 去掉 raw_payload_id，null 字段参与 hash', () => {
    const base = { platform: 'pdd' as const, order_id: 'o', paid_fen: 1n, commission_fen: 2n };
    expect(orderCanonicalJson({ ...base, raw_payload_id: '9' })).toBe(
      '{"commission_fen":"2","order_id":"o","paid_fen":"1","platform":"pdd"}',
    );
    expect(orderContentHash({ ...base, goods_id: null })).not.toBe(orderContentHash(base));
  });

  it('[AC-B1-08h#U5] 首态 P12 缺两个时间时按 P2 落 PAID 并保留 NO_RECEIVED_AT', () => {
    expect(planImportState('PLATFORM_SETTLED', null, null)).toEqual({
      kind: 'insert',
      platform_status: 'PAID',
      received_at: null,
      pending: 'NO_RECEIVED_AT',
      history: [{ from_status: null, event: 'PLATFORM_PAID', to_status: 'PAID' }],
    });
    expect(planImportState('PLATFORM_DEPOSIT_PAID', null, null)).toMatchObject({
      platform_status: 'DEPOSIT_PAID',
    });
  });
});
