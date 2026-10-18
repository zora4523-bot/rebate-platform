import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  createRiskStateService,
  RiskStateConflictError,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { setup, seedState } from './kit.ts';
import { serviceOptions } from './service-kit.ts';
const h = useHarness();

it.each([
  [null, 0],
  [null, 7],
  [0, null],
  [8, 7],
  [6, 7],
] as const)('[AC-F1-07d#33] 唯一写入口本身比较 expected=%s 与 row=%s', async (expected, actual) => {
  const s = await setup(h);
  if (actual !== null) await seedState(s, 'normal', actual);
  const before = await s.snapshot();
  const state = createRiskStateService(serviceOptions(s));
  await expect(
    h.db.transaction().execute((trx) =>
      state.setRiskState(trx, {
        app_id: s.appId,
        user_id: s.userId,
        state: 'banned',
        reason_category: 'other',
        reason: '人工封禁',
        frozen_until: null,
        changed_by: s.a.username,
        expected_row_version: expected,
      }),
    ),
  ).rejects.toBeInstanceOf(RiskStateConflictError);
  expect(await s.snapshot()).toEqual(before);
});
