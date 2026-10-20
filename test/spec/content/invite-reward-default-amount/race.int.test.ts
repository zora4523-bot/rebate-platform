import { expect, it } from 'vitest';
// Frozen helper waits for a real PG blocker after A's read; parameters/rows use bigint replacer.
import { orderedRace } from '../invite-reward-config/ordered-race.ts';
import {
  AMOUNT,
  ENABLED,
  budgets,
  checkRejected,
  checkSuccess,
  current,
  prepare,
  putRow,
  setup,
  snapshot,
  useHarness,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-02zza#8] 缺行金额开启与首写 0 按活动锁串行，两种先读顺序均不能双赢', async () => {
  for (const zeroFirst of [false, true]) {
    const f = await setup(h);
    await budgets(h, f);
    await putRow(h, f.appId, ENABLED, false);
    expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
    const open = await prepare(f, 'switch', ENABLED, { value: true, expected_version: 1 });
    const zero = await prepare(f, 'update', AMOUNT, { value: 0, expected_version: 0 });
    const before = await snapshot(h, f.appId);
    const result = await orderedRace(
      h,
      f,
      zeroFirst ? zero : open,
      zeroFirst ? open : zero,
      zeroFirst ? ENABLED : AMOUNT,
    );
    const opened = zeroFirst ? result.second : result.first;
    const zeroed = zeroFirst ? result.first : result.second;
    // Require the first reader to win, rather than accepting an implementation that ALWAYS
    // refuses opening a missing amount and happens to preserve the no-double-win invariant.
    await checkSuccess(result.first, zeroFirst ? 'update' : 'switch');
    await checkRejected(result.second, zeroFirst ? 'switch' : 'update', ['value']);
    expect([opened.statusCode, zeroed.statusCode].sort()).toStrictEqual([200, 400]);
    if (zeroFirst) {
      expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: false, version: 1 });
      expect(await current(h, f.appId, AMOUNT)).toMatchObject({ value: 0, version: 1 });
    } else {
      expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 2 });
      expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
    }
    const after = await snapshot(h, f.appId);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions[0]).toMatchObject({ key: zeroFirst ? AMOUNT : ENABLED });
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.items.filter((row) => row.key !== ENABLED && row.key !== AMOUNT)).toStrictEqual(
      before.items.filter((row) => row.key !== ENABLED),
    );
  }
}, 30_000);
