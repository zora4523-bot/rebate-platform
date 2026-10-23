// B1-22n (BR-ATTR-05 细则「open 业务校验的先后」⑥ 授权门 → ⑦ 推广位 → ⑧ 价格复核与转链；
// D10-239 T3a / T3b): the slot of the account in use is settled before the price re-check, and a
// Pinduoduo filing refusal (30111, ⑥) comes before a missing slot (⑦).
// Built on the open-pdd-auth fixture (one tenant per case, the jd / pdd open as the composition
// wires it) and B1-19d's per-account slots (real union_pids rows read through the pid service).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createPddAuthLinkOpen,
  type PddAuthLinkOpenOptions,
} from '../../../../apps/api/src/modules/linking/application/link-open-pdd-auth.ts';
import type {
  LinkOpenOwnerResult,
  LinkOpenPrice,
} from '../../../../apps/api/src/modules/linking/index.ts';
import type { ActivePidInput } from '../../../../apps/api/src/modules/union/index.ts';
import { accountSlots } from '../../union/pids-by-account/kit.ts';
import { response } from '../open-pdd-auth/assertions.ts';
import { fixture, outcome, type Fixture } from '../open-pdd-auth/kit.ts';

export { databaseFixture } from '../open-pdd-auth/database.ts';
export { fixture, outcome, response, type Fixture };

export const TIMEOUT = 60_000;

/** A re-check outcome injected through the price double (BR-PRICE-13). */
export type Recheck = 'off_shelf' | 'unavailable' | 'price_changed';

/**
 * Each injected re-check outcome, and what the same open answers when the slot exists (unchanged
 * behaviour: the re-check runs and decides). Opens without no_rebate only.
 */
export const RECHECKS: readonly { readonly recheck: Recheck; readonly withSlot: number }[] = [
  { recheck: 'off_shelf', withSlot: 30141 },
  { recheck: 'unavailable', withSlot: 50303 },
  { recheck: 'price_changed', withSlot: 0 },
];

export type Scene = 'detail' | 'agent' | 'share';
export type SlotScene = 'self_buy' | 'agent' | 'share';

/** BR-ATTR-08: the pid_scene of a link's scene; no_rebate always uses self_buy. */
export function slotSceneOf(scene: Scene, noRebate = false): SlotScene {
  if (noRebate || scene === 'detail') return 'self_buy';
  return scene;
}

/** Makes the price double answer `recheck` (its first answer is the registered quote). */
export async function injectRecheck(f: Fixture, recheck: Recheck): Promise<void> {
  const original = f.fetch.getMockImplementation();
  if (original === undefined) throw new Error('synthetic fixture: no price double');
  // The fixture's double ignores the owner; this read is not one of the open's re-checks.
  const priced: LinkOpenPrice = await original({} as LinkOpenOwnerResult);
  if (recheck === 'off_shelf') {
    f.fetch.mockResolvedValue({ kind: 'off_shelf' });
    return;
  }
  if (recheck === 'unavailable') {
    f.fetch.mockRejectedValue(new Error('synthetic: re-check unavailable'));
    return;
  }
  if (priced.kind !== 'available') throw new Error('synthetic fixture: not an available quote');
  const { item } = priced.input;
  // 10 yuan more, coupon unchanged: above the default threshold (100 fen), a renewed snapshot.
  f.fetch.mockResolvedValue({
    kind: 'available',
    input: {
      ...priced.input,
      item: {
        ...item,
        price_fen: item.price_fen + 1000n,
        final_price_fen: item.final_price_fen + 1000n,
        quoted_at: f.clock.now().toISOString(),
      },
    },
  });
}

/** JD slots: the fixture's active slot of every scene except `missing` (BR-ATTR-05 ⑦ 京东行). */
export function jdPids(f: Fixture, missing: SlotScene): PddAuthLinkOpenOptions['pids'] {
  return {
    getActivePid: vi.fn(async (input: ActivePidInput) =>
      input.pidScene === missing ? null : f.options.pids.getActivePid(input),
    ),
  };
}

/**
 * Pinduoduo slots per account (B1-19d): account A (the fixture's, the bindings' account) and an
 * earlier account B each have an active self_buy, share and agent slot; `retire` lists the slots
 * set retired before any open.
 */
export async function pddSlots(
  db: Kysely<DB>,
  f: Fixture,
  retire: readonly { readonly account: 'a' | 'b'; readonly scene: SlotScene }[] = [],
) {
  const slots = await accountSlots(db, f.appId, 'pdd', f.accountId);
  const ids = retire.map(({ account, scene }) => slots[account][scene].id);
  if (ids.length > 0) {
    await db
      .updateTable('union_pids')
      .set({ status: 'retired' })
      .where('app_id', '=', f.appId)
      .where('id', 'in', ids)
      .execute();
  }
  return slots;
}

type ConfigReader = PddAuthLinkOpenOptions['config'];
type SettingValue = NonNullable<Awaited<ReturnType<ConfigReader['configValue']>>>['value'];

/** The fixture's settings with `key` set to `value` (a value the fixture's own map cannot hold). */
export function withSetting(f: Fixture, key: string, value: SettingValue): ConfigReader {
  return {
    configValue: async (appId: string, name: string) =>
      name === key ? { value, version: 1 } : f.options.config.configValue(appId, name),
  };
}

/**
 * The open of this fixture with the given slots (and settings, when given); every union adapter
 * call is recorded by method name (the external interfaces a test can observe).
 */
export function openWith(
  f: Fixture,
  pids: PddAuthLinkOpenOptions['pids'],
  config: ConfigReader = f.options.config,
) {
  const inner = f.options.registry.get(f.row.platform as 'jd' | 'pdd');
  const external: string[] = [];
  const watched = Object.fromEntries(
    Object.entries(inner).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            external.push(name);
            return (value as (...values: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  ) as typeof inner;
  const service = createPddAuthLinkOpen({
    ...f.options,
    pids,
    config,
    registry: { get: () => watched },
  });
  return { service, external };
}

/**
 * ⑦ before ⑧: 50301 with no jump; no price fetch, no catalog quote, no conversion, no attempt and
 * no renewed link; the failure is logged for the opened link.
 */
export async function expectStoppedBeforeRecheck(f: Fixture, result: unknown): Promise<void> {
  const value = await response(result, 50301, 503);
  expect(value.envelope.data ?? {}).not.toHaveProperty('jump');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(await f.attempts()).toEqual([]);
  expect((await f.links()).map((link) => link.link_id)).toEqual([f.row.link_id]);
  expect(await f.logs()).toEqual([
    expect.objectContaining({ link_id: f.row.link_id, result_code: 50301 }),
  ]);
}

/** ⑥ answered: 30111 with only auth_jump, a state bound to A's device and the opened link. */
export async function expectFilingRefusal(f: Fixture, result: unknown, before: unknown) {
  const value = await response(result, 30111, 422);
  const data = value.envelope.data as { auth_jump: components['schemas']['AuthJumpPlan'] };
  expect(Object.keys(data)).toEqual(['auth_jump']);
  const sessions = await f.sessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    app_id: f.appId,
    user_id: f.a.userId,
    device_id: f.a.deviceId,
    platform: 'pdd',
    link_id: f.row.link_id,
    used_at: null,
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(await f.attempts()).toEqual([]);
  expect(await f.bindings()).toEqual(before);
  expect(await f.logs()).toEqual([
    expect.objectContaining({ link_id: f.row.link_id, result_code: 30111 }),
  ]);
}

/** With the slot the re-check still runs once and decides the answer (unchanged behaviour). */
export function expectRecheckDecided(f: Fixture, result: unknown, code: number): void {
  expect(result).toMatchObject({ envelope: { code } });
  if (code === 0) expect(result).toMatchObject({ envelope: { data: { price_changed: true } } });
  expect(f.fetch).toHaveBeenCalledTimes(1);
}
