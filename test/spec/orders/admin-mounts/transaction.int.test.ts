// B1-10m: the audit record and the write of each operation commit together on the real admin entry.
// A one-shot failure of the audit insert leaves nothing of the request (50001); the same request
// then goes through, with exactly one audit record bound to the operator and the client address.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ANSWER,
  GRANTS,
  IP,
  accepted,
  allowed,
  arrange,
  refused,
  setup,
  type Action,
} from './kit.ts';

const h = useHarness();

const AUDITED: readonly (readonly [Action, string])[] = [
  ['approve', 'claim_item_approve'],
  ['reject', 'claim_item_reject'],
  ['hold', 'order_hold'],
  ['unhold', 'order_unhold'],
  ['reassign', 'order_assign'],
];

it.each(AUDITED)(
  '[AC-B1-10m#25] %s：审计 %s 写入失败 → 50001，整个请求回滚；重试成功且只有一条审计',
  async (action, auditAction) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    const before = await s.state();
    s.fault.action = auditAction;
    await refused(await act(await allowed(s, action)), 50001);
    expect(s.fault.tripped, `the ${auditAction} audit insert was reached`).toBe(1);
    expect(await s.state()).toEqual(before);

    await accepted(await act(await allowed(s, action)), ANSWER[action]);
    const after = await s.state();
    expect(after.audits).toEqual([
      expect.objectContaining({ action: auditAction, admin_id: s.admin.id, ip: IP }),
    ]);
  },
  120_000,
);
