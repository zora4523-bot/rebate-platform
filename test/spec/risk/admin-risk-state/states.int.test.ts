import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { ACTIONS, body, setup, seedState, accepted, rejected } from './kit.ts';
const h = useHarness();
// Oracle transcribed from the contract, never from the production transition table.
const allowed = {
  ban: ['absent', 'normal', 'frozen'],
  unban: ['banned'],
  freeze: ['absent', 'normal', 'frozen'],
  unfreeze: ['frozen'],
};
for (const state of ['absent', 'normal', 'frozen', 'banned', 'appealing'] as const) {
  it.each(ACTIONS)(`[AC-F1-07d#11] ${state} → %s 完整状态表`, async (action) => {
    const s = await setup(h);
    if (state !== 'absent') await seedState(s, state);
    const before = await s.snapshot();
    const input = body(action, state === 'absent' ? null : 7);
    const response = await s.put(input);
    if (!allowed[action].includes(state)) {
      await rejected(response, 44004);
      expect(await s.snapshot()).toEqual(before);
      return;
    }
    const to = action === 'ban' ? 'banned' : action === 'freeze' ? 'frozen' : 'normal';
    expect(await accepted(response)).toMatchObject({
      state: to,
      row_version: state === 'absent' ? 0 : 8,
      reason: input.reason,
      reason_category: input.reason_category ?? null,
      frozen_until: null,
      changed_by: s.a.username,
      changed_at: s.f.clock.now().toISOString(),
    });
    expect(await s.riskRows()).toMatchObject([{ state: to, changed_at: s.f.clock.now() }]);
    const audits = await s.riskAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      admin_id: s.a.id,
      target: s.userId,
      action: 'user_risk_state_change',
      before: { state: state === 'absent' ? 'normal' : state },
      after: { state: to, reason: input.reason, reason_category: input.reason_category ?? null },
    });
    const events = await s.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      v: 1,
      data: {
        app_id: s.appId,
        user_id: s.userId,
        from: state === 'absent' ? 'normal' : state,
        to,
        reason_category: input.reason_category ?? null,
        frozen_until: null,
      },
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(input.reason);
  });
}
it('[AC-F1-07d#12] 再次冻结改写截止时间、原因类别与原因', async () => {
  const s = await setup(h);
  await seedState(s, 'frozen');
  expect(
    await accepted(
      await s.put({
        ...body('freeze', 7),
        reason_category: 'account_security',
        reason: '复核延期',
        frozen_until: '2099-12-31T00:00:00Z',
      }),
    ),
  ).toMatchObject({
    state: 'frozen',
    reason_category: 'account_security',
    reason: '复核延期',
    frozen_until: '2099-12-31T00:00:00.000Z',
    row_version: 8,
  });
});
it.each([
  [null, 0],
  [null, 7],
  [0, null],
  [8, 7],
  [6, 7],
] as const)('[AC-F1-07d#13] CAS expected=%s 实际=%s 不匹配返回 20902', async (expected, actual) => {
  const s = await setup(h);
  if (actual !== null) await seedState(s, 'normal', actual);
  const before = await s.snapshot();
  await rejected(await s.put(body('ban', expected)), 20902, { resource: 'user_risk_state' });
  expect(await s.snapshot()).toEqual(before);
});
it('[AC-F1-07d#14] 两个 null 首建只有一个成功，另一方 20902，不覆盖已建行', async () => {
  const s = await setup(h);
  const first = await s.issue();
  const second = await s.issue();
  const responses = await Promise.all([
    s.put(body('freeze'), { token: first }),
    s.put(body('freeze'), { token: second }),
  ]);
  expect(responses.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 20902]);
  for (const response of responses) {
    if (response.json().code === 0) await accepted(response);
    else await rejected(response, 20902, { resource: 'user_risk_state' });
  }
  expect(await s.riskRows()).toMatchObject([{ row_version: 0 }]);
  expect(await s.riskAudits()).toHaveLength(1);
  expect(await s.events()).toHaveLength(1);
});
