import { pid_scene, scene } from '@couli/contracts-ts';
import { describe, expect, it } from 'vitest';
import {
  LinkingError,
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
