import { describe, expect, it, vi } from 'vitest';
import { createConversionPrecheck } from './link-open-conversion.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';

// Synthetic app, user, accounts and slots (no real platform values).
const APP = 'synthetic-app';
const USER = '0199a3b4-5c6d-7000-8000-0000000000a1';
const ACCOUNT_A = '0199a3b4-5c6d-7000-8000-0000000000b1';
const ACCOUNT_B = '0199a3b4-5c6d-7000-8000-0000000000b2';

type Precheck = Parameters<typeof createConversionPrecheck>[0];
type PidQuery = Parameters<Precheck['pids']['getActivePid']>[0];

function ownerOf(platform: string, pidScene: string): LinkOpenOwnerResult {
  return {
    link: { app_id: APP, platform, link_id: 'synthetic-link' },
    identitySnapshot: { user_id: USER, pid_scene: pidScene },
  } as unknown as LinkOpenOwnerResult;
}

/** One active slot per (account, scene) in `slots`; every other read answers null. */
function harness(
  slots: readonly { readonly account: string; readonly scene: string }[],
  settings: Readonly<Record<string, unknown>> = {},
) {
  const getActivePid = vi.fn(async (query: PidQuery) => {
    const found = slots.find(
      (slot) =>
        slot.scene === query.pidScene &&
        (query.unionAccountId === undefined || slot.account === query.unionAccountId),
    );
    if (found === undefined) return null;
    return {
      app_id: APP,
      platform: query.platform,
      pid_scene: query.pidScene,
      status: 'active',
      pid: `synthetic-${found.account}-${found.scene}`,
      union_account_id: found.account,
    } as unknown as Awaited<ReturnType<Precheck['pids']['getActivePid']>>;
  });
  const attrCode = vi.fn(async () => 'abcd1234');
  const warn = vi.fn();
  const precheck = createConversionPrecheck({
    pids: { getActivePid },
    attrCodes: { attrCode },
    config: {
      configValue: async (_app: string, key: string) =>
        key in settings ? { value: settings[key] as never, version: 1 } : null,
    } as Precheck['config'],
    logger: { warn },
  });
  return { precheck, getActivePid, attrCode, warn };
}

describe('conversion precheck before the re-check (B1-22n)', () => {
  it('[AC-B1-22n] jd: the scene with no active slot is a paused failure; with one it passes', async () => {
    const h = harness([{ account: ACCOUNT_A, scene: 'self_buy' }]);
    await expect(
      h.precheck({ owner: ownerOf('jd', 'agent'), noRebate: false, traceId: 't' }),
    ).rejects.toMatchObject({ code: 50301 });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'linking.open.no_active_pid', pid_scene: 'agent' }),
      expect.any(String),
    );
    await expect(
      h.precheck({ owner: ownerOf('jd', 'detail'), noRebate: true, traceId: 't' }),
    ).resolves.toBeUndefined();
    // no_rebate uses the self_buy slot and reads no attr_code.
    expect(h.getActivePid).toHaveBeenLastCalledWith(
      expect.objectContaining({ pidScene: 'self_buy', purpose: 'convert' }),
    );
    expect(h.attrCode).not.toHaveBeenCalled();
  });

  it('[AC-B1-22n] jd: a user key mode not served is a paused failure; no_rebate is not affected', async () => {
    const h = harness(
      [
        { account: ACCOUNT_A, scene: 'agent' },
        { account: ACCOUNT_A, scene: 'self_buy' },
      ],
      {
        'attr.jd.user_key_mode': 'private_position',
      },
    );
    await expect(
      h.precheck({ owner: ownerOf('jd', 'agent'), noRebate: false, traceId: 't' }),
    ).rejects.toMatchObject({ code: 50301 });
    await expect(
      h.precheck({ owner: ownerOf('jd', 'agent'), noRebate: true, traceId: 't' }),
    ).resolves.toBeUndefined();
  });

  it('[AC-B1-22n] pdd: only the account in use counts, never another account slot', async () => {
    const h = harness([{ account: ACCOUNT_B, scene: 'agent' }]);
    await expect(
      h.precheck({
        owner: ownerOf('pdd', 'agent'),
        noRebate: false,
        traceId: 't',
        unionAccountId: ACCOUNT_A,
      }),
    ).rejects.toMatchObject({ code: 50301 });
    expect(h.getActivePid).toHaveBeenCalledWith(
      expect.objectContaining({ pidScene: 'agent', unionAccountId: ACCOUNT_A }),
    );
    await expect(
      h.precheck({
        owner: ownerOf('pdd', 'agent'),
        noRebate: false,
        traceId: 't',
        unionAccountId: ACCOUNT_B,
      }),
    ).resolves.toBeUndefined();
  });

  it('[AC-B1-22n] a missing attr_code is a paused failure; other platforms pass untouched', async () => {
    const h = harness([{ account: ACCOUNT_A, scene: 'agent' }]);
    h.attrCode.mockResolvedValue(null as never);
    await expect(
      h.precheck({ owner: ownerOf('jd', 'agent'), noRebate: false, traceId: 't' }),
    ).rejects.toMatchObject({ code: 50301 });
    h.getActivePid.mockClear();
    await expect(
      h.precheck({ owner: ownerOf('taobao', 'agent'), noRebate: false, traceId: 't' }),
    ).resolves.toBeUndefined();
    expect(h.getActivePid).not.toHaveBeenCalled();
  });
});
