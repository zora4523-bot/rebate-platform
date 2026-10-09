import { describe, expect, it } from 'vitest';
import { taobaoCacheTag, taobaoTaoke, type TaobaoAuthorized } from './link-open-taobao.ts';

// Synthetic union account ids (two accounts of one app) and slots.
const ACCOUNT_X = '0199a3b4-5c6d-7000-8000-0000000000a1';
const ACCOUNT_Y = '0199a3b4-5c6d-7000-8000-0000000000a2';
const SLOT_X = { pid: 'mm_1_2_3', union_account_id: ACCOUNT_X };
const SLOT_Y = { pid: 'mm_4_5_6', union_account_id: ACCOUNT_Y };

function attributed(
  slot: TaobaoAuthorized['slot'],
  bindingAccountId: string,
  relationId = '42',
): TaobaoAuthorized {
  return { relationId, bindingAccountId, slot };
}

describe('Taobao instruction attribution (B1-06f)', () => {
  it('[AC-B1-06f] relation_id is paired only with a slot of the binding union account', () => {
    // A (account X, relation 42) and B (account Y, relation 42): the same relation_id under two
    // accounts. A's relation on Y's slot would attribute A's purchase to B.
    expect(taobaoTaoke(attributed(SLOT_X, ACCOUNT_X))).toEqual({
      pid: 'mm_1_2_3',
      relation_id: '42',
    });
    expect(taobaoTaoke(attributed(SLOT_Y, ACCOUNT_X))).toBeNull();
    expect(taobaoTaoke(attributed(SLOT_X, ACCOUNT_Y))).toBeNull();
    expect(taobaoTaoke(attributed(SLOT_Y, ACCOUNT_Y))).toEqual({
      pid: 'mm_4_5_6',
      relation_id: '42',
    });
  });

  it('[AC-B1-06f] no_rebate carries the slot alone, whatever its account', () => {
    const none: TaobaoAuthorized = { relationId: null, bindingAccountId: null, slot: SLOT_Y };
    expect(taobaoTaoke(none)).toEqual({ pid: 'mm_4_5_6' });
    expect(taobaoTaoke({ ...none, bindingAccountId: ACCOUNT_X })).toEqual({ pid: 'mm_4_5_6' });
  });

  it('[AC-B1-06f] a relation without a binding account is refused', () => {
    expect(taobaoTaoke({ relationId: '42', bindingAccountId: null, slot: SLOT_X })).toBeNull();
  });
});

describe('Taobao cache tag (B1-06f)', () => {
  it('[AC-B1-06f] a retired and replaced slot, or a slot of another account, is a miss', () => {
    const first = taobaoCacheTag(attributed(SLOT_X, ACCOUNT_X), false);
    expect(taobaoCacheTag(attributed(SLOT_X, ACCOUNT_X), false)).toBe(first);
    // Slot rotated within the TTL: same relation_id, new pid.
    expect(taobaoCacheTag(attributed({ ...SLOT_X, pid: 'mm_1_2_4' }, ACCOUNT_X), false)).not.toBe(
      first,
    );
    // Same pid string under another account.
    expect(
      taobaoCacheTag(attributed({ ...SLOT_X, union_account_id: ACCOUNT_Y }, ACCOUNT_X), false),
    ).not.toBe(first);
    // Same relation_id bound under another account (two accounts, same relation_id).
    expect(taobaoCacheTag(attributed(SLOT_X, ACCOUNT_Y), false)).not.toBe(first);
    // Rebind: a new relation_id.
    expect(taobaoCacheTag(attributed(SLOT_X, ACCOUNT_X, '43'), false)).not.toBe(first);
  });

  it('[AC-B1-06f] no_rebate is tagged by its selected slot and never meets the attributed tag', () => {
    const none: TaobaoAuthorized = { relationId: null, bindingAccountId: null, slot: SLOT_X };
    const tag = taobaoCacheTag(none, true);
    expect(taobaoCacheTag(none, true)).toBe(tag);
    expect(taobaoCacheTag({ ...none, slot: { ...SLOT_X, pid: 'mm_1_2_4' } }, true)).not.toBe(tag);
    expect(
      taobaoCacheTag({ ...none, slot: { ...SLOT_X, union_account_id: ACCOUNT_Y } }, true),
    ).not.toBe(tag);
    expect(taobaoCacheTag(attributed(SLOT_X, ACCOUNT_X), true)).toBe(tag);
    expect(taobaoCacheTag(attributed(SLOT_X, ACCOUNT_X), false)).not.toBe(tag);
  });

  it('[AC-B1-06f] an open not authorized here gets a tag no stored entry has', () => {
    expect(taobaoCacheTag(undefined, false)).toBe('unauthorized');
    expect(taobaoCacheTag(undefined, true)).toBe('unauthorized');
    expect(taobaoCacheTag({ relationId: null, bindingAccountId: null, slot: SLOT_X }, false)).toBe(
      'unauthorized',
    );
  });
});
