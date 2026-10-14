import { describe, expect, it } from 'vitest';
import { pddCacheTag } from './link-open-pdd-auth.ts';

// Synthetic ids of two union accounts and two bindings of one app.
const ACCOUNT_X = '0199a3b4-5c6d-7000-8000-0000000000b1';
const ACCOUNT_Y = '0199a3b4-5c6d-7000-8000-0000000000b2';
const BINDING_1 = '0199a3b4-5c6d-7000-8000-0000000000c1';
const BINDING_2 = '0199a3b4-5c6d-7000-8000-0000000000c2';
const SLOT = { pid: 'synthetic-self_buy', union_account_id: ACCOUNT_X };

describe('Pinduoduo cache tag (B1-06v)', () => {
  it('[AC-B1-06v] a rebind, another account or another slot is a miss', () => {
    const first = pddCacheTag(
      { binding: { id: BINDING_1, accountId: ACCOUNT_X }, slot: SLOT },
      false,
    );
    expect(
      pddCacheTag({ binding: { id: BINDING_1, accountId: ACCOUNT_X }, slot: SLOT }, false),
    ).toBe(first);
    expect(
      pddCacheTag({ binding: { id: BINDING_2, accountId: ACCOUNT_X }, slot: SLOT }, false),
    ).not.toBe(first);
    expect(
      pddCacheTag({ binding: { id: BINDING_1, accountId: ACCOUNT_Y }, slot: SLOT }, false),
    ).not.toBe(first);
    expect(
      pddCacheTag(
        { binding: { id: BINDING_1, accountId: ACCOUNT_X }, slot: { ...SLOT, pid: 'synthetic-2' } },
        false,
      ),
    ).not.toBe(first);
  });

  it('[AC-B1-06v] no_rebate is tagged by its slot and never meets an attributed tag', () => {
    const none = pddCacheTag({ binding: null, slot: SLOT }, true);
    expect(
      pddCacheTag({ binding: { id: BINDING_1, accountId: ACCOUNT_X }, slot: SLOT }, true),
    ).toBe(none);
    expect(
      pddCacheTag({ binding: { id: BINDING_1, accountId: ACCOUNT_X }, slot: SLOT }, false),
    ).not.toBe(none);
  });

  it('[AC-B1-06v] an open not authorized here gets a tag no stored entry has', () => {
    expect(pddCacheTag(undefined, false)).toBe('unauthorized');
    expect(pddCacheTag(undefined, true)).toBe('unauthorized');
    expect(pddCacheTag({ binding: null, slot: SLOT }, false)).toBe('unauthorized');
  });
});
