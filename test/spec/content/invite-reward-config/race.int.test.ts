import { expect, it } from 'vitest';
import {
  checkRejected,
  checkSuccess,
  current,
  getItem,
  positive,
  prepare,
  putRow,
  putVersion,
  setup,
  snapshot,
  useHarness,
} from './kit.ts';
import { ENABLED, POSITIVE_WHEN_ENABLED } from './oracle.ts';
import { orderedRace } from './ordered-race.ts';

const h = useHarness();
const cases = POSITIVE_WHEN_ENABLED.flatMap((key) =>
  (['update', 'batch', 'rollback'] as const).flatMap((operation) =>
    [false, true].map((zeroFirst) => ({ key, operation, zeroFirst })),
  ),
);

it.each(cases)(
  '[AC-F1-02zn#17] 并发开关与 $operation $key=0（先读置零路=$zeroFirst）：不可双赢',
  async ({ key, operation, zeroFirst }) => {
    const f = await setup(h);
    await positive(h, f, key);
    await putRow(h, f.appId, key, 100, 2);
    await putVersion(h, f.appId, key, 1, 0, f.actor);
    // ENABLED deliberately has no row: a row lock alone must not leave the first-write gap.
    expect(await getItem(f, key)).toMatchObject({ value: 100, version: 2 });
    const open = await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 });
    const body =
      operation === 'batch'
        ? { items: [{ key, value: 0, expected_version: 2 }] }
        : operation === 'rollback'
          ? { to_version: 1, expected_version: 2 }
          : { value: 0, expected_version: 2 };
    const zero = await prepare(f, operation, key, body);
    const before = await snapshot(h, f.appId);
    const result = await orderedRace(
      h,
      f,
      zeroFirst ? zero : open,
      zeroFirst ? open : zero,
      zeroFirst ? ENABLED : key,
    );
    const openResponse = zeroFirst ? result.second : result.first;
    const zeroResponse = zeroFirst ? result.first : result.second;
    expect([openResponse.statusCode, zeroResponse.statusCode].sort()).toStrictEqual([200, 400]);
    const fields =
      operation === 'batch' ? [key] : operation === 'rollback' ? ['to_version'] : ['value'];
    if (openResponse.statusCode === 200) {
      await checkSuccess(openResponse, 'switch');
      await checkRejected(zeroResponse, operation, fields);
      expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
      expect(await current(h, f.appId, key)).toMatchObject({ value: 100, version: 2 });
    } else {
      await checkRejected(openResponse, 'switch', ['value']);
      await checkSuccess(zeroResponse, operation);
      expect(await current(h, f.appId, ENABLED)).toBeUndefined();
      expect(await current(h, f.appId, key)).toMatchObject({ value: 0, version: 3 });
    }
    const after = await snapshot(h, f.appId);
    expect(after.versions.length - before.versions.length).toBe(1);
    expect(after.audits.length - before.audits.length).toBe(1);
  },
  30_000,
);
