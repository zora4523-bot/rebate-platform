// B1-22u (编排裁定 D10-434 ①; BR-ATTR-05 细则「open 业务校验的先后」⑦, BR-PRICE-13): the jd / pdd
// open's slot check before the re-check (B1-22n createConversionPrecheck) reads the scene's active
// slot, the attr_code and the jd user key mode. Only "none" is 50301 there; a read that FAILS with
// anything but 50301 (a database statement timeout, the union pid service failing) answers 50303,
// as the same read failing inside the conversion did before B1-22n, with one link_log row
// (result_code 50303) and nothing else written: no 500, no thrown error, no rollback of the log.
// Built on the open-pdd-auth fixture through B1-22n's open-pid-before-requote kit (one tenant per
// case, the jd / pdd open as the composition wires it; the slot reader is the fixture's double).
import { expect, vi } from 'vitest';
import {
  createPddAuthLinkOpen,
  type PddAuthLinkOpenOptions,
} from '../../../../apps/api/src/modules/linking/application/link-open-pdd-auth.ts';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import type { ActivePidInput } from '../../../../apps/api/src/modules/union/index.ts';
import { noAuthEntry } from '../open-pdd-auth/assertions.ts';
import {
  TIMEOUT,
  databaseFixture,
  expectStoppedBeforeRecheck,
  fixture,
  outcome,
  response,
  slotSceneOf,
  type Fixture,
  type SlotScene,
} from '../open-pid-before-requote/kit.ts';

export {
  TIMEOUT,
  databaseFixture,
  expectStoppedBeforeRecheck,
  fixture,
  outcome,
  response,
  slotSceneOf,
};
export type { Fixture, SlotScene };

/** A credential inside a driver's error text: it must never reach a log, link_log or response. */
export const SECRET = 'plain-plain-plain-plain';

/** A statement timeout as pg reports it (SQLSTATE 57014 in `code`), with a DSN in its text. */
export function databaseTimeout(): Error {
  return Object.assign(
    new Error(
      `synthetic: canceling statement due to statement timeout (postgres://couli_app:${SECRET}@db.synthetic.test/couli)`,
    ),
    { code: '57014' },
  );
}

/** A read failure carrying no code at all. */
export function readFailure(): Error {
  return new Error(`synthetic: identity read failed (password=${SECRET})`);
}

type Pids = PddAuthLinkOpenOptions['pids'];

/**
 * The read ⑦ makes for this open: the slot of `scene`, scoped to the account in use for pdd
 * (B1-19d: the fixture's active binding is on f.accountId), app-wide for jd.
 */
export function precheckRead(f: Fixture, scene: SlotScene): (input: ActivePidInput) => boolean {
  const platform = f.row.platform;
  return (input) =>
    input.platform === platform &&
    input.pidScene === scene &&
    (platform === 'pdd'
      ? input.unionAccountId === f.accountId
      : input.unionAccountId === undefined);
}

/** The fixture's slots, except that reads matching `hit` reject with `answer` (or answer none). */
export function pidsWith(
  f: Fixture,
  hit: (input: ActivePidInput) => boolean,
  answer: Error | null,
): Pids {
  return {
    getActivePid: vi.fn(async (input: ActivePidInput) => {
      if (!hit(input)) return f.options.pids.getActivePid(input);
      if (answer === null) return null;
      throw answer;
    }),
  };
}

/**
 * The open of this fixture with the given slot reader and its own logger double; every union
 * adapter call is recorded by method name (the external interfaces a test can observe).
 */
export function openWatched(f: Fixture, pids: Pids = f.options.pids) {
  const warn = vi.fn();
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
    logger: { warn },
    registry: { get: () => watched },
  });
  return { service, external, warn };
}

export type Watched = ReturnType<typeof openWatched>;

/** JSON text of anything a test inspects (bigint columns as strings, errors with their text). */
export function plain(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) {
      return { ...item, name: item.name, message: item.message, stack: item.stack };
    }
    return item;
  });
}

/**
 * The precheck read failed (not 50301): 50303 with no jump and no authorization entry; no price
 * fetch, catalog quote, conversion, attempt, renewed link, cache entry, authorization session,
 * binding change or union call; exactly one link_log row for the opened link with result_code
 * 50303. No credential from the error and no user / device id in what is logged or answered.
 */
export async function expectReadFailure(
  f: Fixture,
  result: unknown,
  watched: Watched,
  before: unknown,
  noRebate = false,
): Promise<void> {
  const value: HandlerResult = await response(result, 50303, 503);
  expect(value.envelope.data ?? {}).not.toHaveProperty('jump');
  noAuthEntry(value);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  expect(f.cache.put).not.toHaveBeenCalled();
  expect(watched.external).toEqual([]);
  expect(await f.attempts()).toEqual([]);
  expect((await f.links()).map((link) => link.link_id)).toEqual([f.row.link_id]);
  expect(await f.sessions()).toEqual([]);
  expect(await f.bindings()).toEqual(before);
  const logs = await f.logs();
  expect(logs).toEqual([
    expect.objectContaining({
      link_id: f.row.link_id,
      result_code: 50303,
      ...(noRebate ? { no_rebate: true } : {}),
    }),
  ]);
  const logged = plain(watched.warn.mock.calls);
  expect(plain(value), 'response').not.toContain(SECRET);
  expect(plain(logs), 'link_log').not.toContain(SECRET);
  expect(logged, 'logger').not.toContain(SECRET);
  for (const identity of [f.a.userId, f.b.userId, f.a.deviceId, f.b.deviceId]) {
    expect(logged, 'logger').not.toContain(identity);
  }
}

export const DAY_MS = 86_400_000;

/** A reading of `clock` moved by `ms`. */
export function shifted(clock: { now(): Date }, ms: number): Date {
  const at = clock.now();
  at.setTime(at.getTime() + ms);
  return at;
}
