import { pid_scene, scene } from '@couli/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  LinkingError,
  couponGone,
  couponIdsOf,
  intSetting,
  priceChanged,
  quoteSnapshotChanged,
  TLJ_OWNER_ONLY_MESSAGE,
  decideOpenOwner,
  isSwitchOn,
  logsRegistration,
  parseScene,
  pidSceneOf,
  urlLifetimeMs,
} from './rules.ts';

describe('linking registration rules', () => {
  it('[AC-B1-06c] every contract scene maps to a convert pid_scene, never fallback or query', () => {
    for (const value of scene) {
      const derived = pidSceneOf(parseScene(value));
      expect(pid_scene).toContain(derived);
      expect(['fallback', 'query']).not.toContain(derived);
    }
  });

  it('[AC-B1-06c] scenes outside the enum fail with 20001', () => {
    for (const value of ['', 'fallback', 'query', 'SEARCH', undefined, null, 1]) {
      expect(() => parseScene(value)).toThrow(LinkingError);
      expect(() => parseScene(value)).toThrow(expect.objectContaining({ code: 20001 }));
    }
  });

  it('[AC-B1-06c] share URLs live 7 days, the others 15 minutes', () => {
    expect(urlLifetimeMs('share')).toBe(604_800_000);
    expect(urlLifetimeMs('self_buy')).toBe(900_000);
    expect(urlLifetimeMs('agent')).toBe(900_000);
    expect(urlLifetimeMs('taolijin')).toBe(900_000);
  });

  it('[AC-B1-06c] only Agent and watch-alert cards log a registration', () => {
    expect(logsRegistration('agent', 'agent')).toBe(true);
    expect(logsRegistration('mcp', 'agent')).toBe(true);
    expect(logsRegistration('watch_alert', 'self_buy')).toBe(true);
    expect(logsRegistration('search', 'self_buy')).toBe(false);
    expect(logsRegistration('share', 'share')).toBe(false);
  });

  it('[AC-B1-06c] a switch is on only for true or "on"', () => {
    expect(isSwitchOn(true)).toBe(true);
    expect(isSwitchOn('on')).toBe(true);
    for (const value of [false, 'off', null, undefined, 'true', 1, 'ON']) {
      expect(isSwitchOn(value)).toBe(false);
    }
  });
});

describe('linking open owner decision', () => {
  const A = 'synthetic-user-a';
  const B = 'synthetic-user-b';
  const base = { scene: 'search', snapshotUserId: A, rowUserId: A } as const;

  it('[AC-B1-06d] a share link opens with the sharer, the sharer himself goes self-buy detail', () => {
    for (const callerUserId of [null, B]) {
      expect(decideOpenOwner({ ...base, scene: 'share', pidScene: 'share', callerUserId })).toEqual(
        { kind: 'use' },
      );
    }
    expect(
      decideOpenOwner({ ...base, scene: 'share', pidScene: 'share', callerUserId: A }),
    ).toEqual({ kind: 'register', scene: 'detail', message: null });
    // The sharer is the snapshot user, not the row's redundant user_id.
    expect(
      decideOpenOwner({
        ...base,
        scene: 'share',
        pidScene: 'share',
        rowUserId: B,
        callerUserId: B,
      }),
    ).toEqual({ kind: 'use' });
  });

  it('[AC-B1-06d] a non-share link needs login, whoever owns it', () => {
    for (const snapshotUserId of [null, A]) {
      expect(
        decideOpenOwner({
          ...base,
          pidScene: 'self_buy',
          snapshotUserId,
          rowUserId: snapshotUserId,
          callerUserId: null,
        }),
      ).toEqual({ kind: 'login' });
    }
  });

  it('[AC-B1-06d] own links open as they are, guest links are claimed, claimed ones are owned', () => {
    expect(decideOpenOwner({ ...base, pidScene: 'self_buy', callerUserId: A })).toEqual({
      kind: 'use',
    });
    expect(
      decideOpenOwner({
        ...base,
        pidScene: 'self_buy',
        snapshotUserId: null,
        rowUserId: null,
        callerUserId: B,
      }),
    ).toEqual({ kind: 'claim' });
    expect(
      decideOpenOwner({ ...base, pidScene: 'self_buy', snapshotUserId: null, callerUserId: A }),
    ).toEqual({ kind: 'use' });
    expect(
      decideOpenOwner({ ...base, pidScene: 'self_buy', snapshotUserId: null, callerUserId: B }),
    ).toEqual({ kind: 'register', scene: 'search', message: null });
  });

  it("[AC-B1-06d] another user's link registers the same scene; taolijin falls back to detail", () => {
    expect(
      decideOpenOwner({ ...base, scene: 'agent', pidScene: 'agent', callerUserId: B }),
    ).toEqual({ kind: 'register', scene: 'agent', message: null });
    expect(
      decideOpenOwner({ ...base, scene: 'taolijin', pidScene: 'taolijin', callerUserId: B }),
    ).toEqual({ kind: 'register', scene: 'detail', message: TLJ_OWNER_ONLY_MESSAGE });
  });
});

describe('linking open re-check rules', () => {
  it.each([
    [2990n, 3090n, true],
    [2990n, 3080n, false],
    [1000n, 950n, true],
    [1000n, 951n, false],
    [1000n, 1050n, true],
    [300000n, 300100n, true],
    [2990n, 2990n, false],
  ] as const)('[AC-B1-06k] BR-PRICE-13 threshold %s → %s = %s', (oldFen, newFen, changed) => {
    expect(priceChanged(oldFen, newFen, 100n, 500n)).toBe(changed);
  });

  it('[AC-B1-06k] BR-PRICE-13 configured thresholds and huge prices stay integer', () => {
    expect(priceChanged(1500n, 1650n, 200n, 1000n)).toBe(true);
    expect(priceChanged(1500n, 1649n, 200n, 1000n)).toBe(false);
    expect(priceChanged(9007199254740993n, 9007199254740991n, 100n, 500n)).toBe(false);
  });

  it('[AC-B1-06k] D33 coupon_gone by coupon ID, else by face value', () => {
    const snap = (couponFen: bigint | null, couponIds: string | null) => ({ couponFen, couponIds });
    expect(couponGone(snap(100n, 'a,z'), { couponFen: 100n, couponIds: 'z' })).toBe(true);
    expect(couponGone(snap(100n, 'a'), { couponFen: 100n, couponIds: 'a,b' })).toBe(false);
    expect(couponGone(snap(100n, 'a'), { couponFen: 0n, couponIds: null })).toBe(true);
    expect(couponGone(snap(0n, null), { couponFen: 100n, couponIds: 'n' })).toBe(false);
    expect(couponGone(snap(100n, null), { couponFen: 100n, couponIds: null })).toBe(false);
    expect(couponGone(snap(100n, null), { couponFen: 50n, couponIds: null })).toBe(true);
  });

  it('[AC-B1-06k] D33 a snapshot changes on price, coupon amount or coupon IDs', () => {
    const base = { finalFen: 2990n, couponFen: 100n, couponIds: 'a' };
    expect(quoteSnapshotChanged(base, { ...base })).toBe(false);
    expect(quoteSnapshotChanged(base, { ...base, finalFen: 2991n })).toBe(true);
    expect(quoteSnapshotChanged(base, { ...base, couponFen: 150n })).toBe(true);
    expect(quoteSnapshotChanged(base, { ...base, couponIds: 'b' })).toBe(true);
    expect(
      quoteSnapshotChanged(
        { ...base, couponFen: null, couponIds: null },
        {
          finalFen: 2990n,
          couponFen: 0n,
          couponIds: couponIdsOf(''),
        },
      ),
    ).toBe(false);
  });

  it('[AC-B1-06k] settings read only non-negative safe integers', () => {
    expect(intSetting(300, 0)).toBe(300);
    expect(intSetting(undefined, 0)).toBe(0);
    expect(intSetting(-1, 900)).toBe(900);
    expect(intSetting('300', 0)).toBe(0);
    expect(intSetting(1.5, 0)).toBe(0);
  });
});
