// F1-10e ruling 16 (CAS): two writes with the same expected_version — exactly one wins, with
// one history version and one audit row; deterministic interleaving in ./ordered-race.ts.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { orderedRace, type Attempt } from './ordered-race.ts';
import {
  KEYS,
  auditsSince,
  conflict,
  current,
  setup,
  snapshot,
  success,
  versionsOf,
  written,
  type Item,
} from './kit.ts';

const h = useHarness();
const key = KEYS.general;

it.each([false, true])(
  '[AC-F1-10e#53] 两个同 expected_version 的改值并发（已有行=%s）：先提交的成功，后者 20902，只多一个版本、一条历史、一条审计',
  async (existing) => {
    const f = await setup(h);
    if (existing) await written(h, f.appId, key, [3], f.actor);
    const expected = existing ? 1 : 0;
    const before = await snapshot(h, f.appId);
    const first: Attempt = {
      op: 'update',
      call: { key, body: { value: 11, expected_version: expected } },
    };
    const second: Attempt = {
      op: 'update',
      call: { key, body: { value: 22, expected_version: expected } },
    };
    const result = await orderedRace(h, f, first, second, existing);
    expect(await success<Item>(result.second, 'update')).toMatchObject({
      value: 22,
      version: expected + 1,
    });
    await conflict(result.first, 'update');
    expect(await current(h, f.appId, key)).toMatchObject({ value: 22, version: expected + 1 });
    const history = await versionsOf(h, f.appId, key);
    expect(history.map((v) => [v.version, v.value])).toStrictEqual(
      existing
        ? [
            [1, 3],
            [2, 22],
          ]
        : [[1, 22]],
    );
    expect(await auditsSince(h, f.appId, before)).toHaveLength(1);
  },
);

it.each(['batch', 'rollback'] as const)(
  '[AC-F1-10e#54] %s 与改值并发、同 expected_version：只成一个，另一个 20902，不留半套写入',
  async (op) => {
    const f = await setup(h);
    await written(h, f.appId, key, [3, 6], f.actor);
    const before = await snapshot(h, f.appId);
    const first: Attempt =
      op === 'batch'
        ? {
            op,
            call: {
              body: {
                items: [
                  { key: KEYS.generalFlag, value: false, expected_version: 0 },
                  { key, value: 33, expected_version: 2 },
                ],
              },
            },
          }
        : { op, call: { key, body: { to_version: 1, expected_version: 2 } } };
    const second: Attempt = {
      op: 'update',
      call: { key, body: { value: 44, expected_version: 2 } },
    };
    const result = await orderedRace(h, f, first, second, true);
    expect(await success<Item>(result.second, 'update')).toMatchObject({ value: 44, version: 3 });
    await conflict(result.first, op);
    expect(await current(h, f.appId, key)).toMatchObject({ value: 44, version: 3 });
    expect(await current(h, f.appId, KEYS.generalFlag)).toBeUndefined();
    expect((await versionsOf(h, f.appId, key)).map((v) => v.version)).toStrictEqual([1, 2, 3]);
    expect(await versionsOf(h, f.appId, KEYS.generalFlag)).toStrictEqual([]);
    expect(await auditsSince(h, f.appId, before)).toHaveLength(1);
  },
);
