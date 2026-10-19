import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  FixedClock,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
  type AuditInput,
} from '../../../platform/index.ts';
import {
  DictConflictError,
  DictItemAdmin,
  type DictItemStore,
} from '../../application/dict-item-admin.ts';
import { getFundTermKeys } from '../../specs/text-specs.ts';
import { AdminDictItemsController } from './dict-items.controller.ts';

const APP = 'dict_ctrl';
const ADMIN = '00000000-0000-4000-8000-0000000000aa';

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];
  refuse: number | null = null;

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    if (this.refuse !== null) {
      throw new HttpException({ code: this.refuse, msg: 'refused', trace_id: 't' }, 403);
    }
    return business({ adminId: ADMIN, appId: APP, isSuper: false, loginName: 'editor' });
  }
}

function fixture(conflict = false) {
  const audits: AuditInput[] = [];
  const work = { calls: 0 };
  const store: DictItemStore = {
    read: () => Promise.reject(new Error('not used')),
    history: () => Promise.reject(new Error('not used')),
    appendAudit: async (input) => {
      audits.push(input);
    },
    transaction: () => {
      work.calls += 1;
      return Promise.reject(conflict ? new DictConflictError() : new Error('not used'));
    },
  };
  const guard = new FakeGuard();
  const admin = new DictItemAdmin(store, new FixedClock('2026-10-19T01:00:00.000Z'), {
    defaults: () => ({}),
    fundTermKeys: getFundTermKeys,
    rules: () => ({ defaults: {}, words: [] }),
  });
  const request = {
    id: 'trace-1',
    ip: '127.0.0.1',
    adminPrincipal: { adminId: ADMIN, appId: APP, sessionId: 's', isSuper: false },
  };
  return { guard, audits, work, request, controller: new AdminDictItemsController(guard, admin) };
}

function responseOf(error: unknown): unknown {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse();
}

it('[AC-F1-02t#u18] 写按键类选权限点：general / fund_terms / agreement 各一个点；读为三者任一且只读', async () => {
  const f = fixture(true);
  const save = (key: string) =>
    f.controller
      .save(f.request, { changes: [{ key, text: '文' }], expected_version: '0' })
      .catch((error: unknown) => error);
  await save('about.copy_diagnostics');
  await save('order_status_group.credited');
  await save('privacy.btn.agree');
  await f.controller
    .rollback(f.request, { keys: ['perm.btn.continue'], to_version: 0, expected_version: '0' })
    .catch(() => undefined);
  expect(f.guard.calls.map((call) => call.permission)).toEqual([
    'config.general',
    'content.fund_terms',
    'content.agreement',
    'content.agreement',
  ]);
  expect(f.guard.calls.every((call) => call.readOnly === undefined)).toBe(true);
  await f.controller.list(f.request, {}).catch(() => undefined);
  await f.controller.history(f.request, {}).catch(() => undefined);
  expect(f.guard.calls.slice(4).map((call) => [call.permission, call.readOnly])).toEqual([
    [['config.general', 'content.fund_terms', 'content.agreement'], true],
    [['config.general', 'content.fund_terms', 'content.agreement'], true],
  ]);
});

it('[AC-F1-02t#u19] 混类或空请求在守卫之前 20001（保存报 changes，回滚报 keys），不审计', async () => {
  const f = fixture();
  const mixed = await f.controller
    .save(f.request, {
      changes: [
        { key: 'about.copy_diagnostics', text: '甲' },
        { key: 'order_status_group.credited', text: '乙' },
      ],
      expected_version: '0',
    })
    .catch((error: unknown) => error);
  expect(responseOf(mixed)).toMatchObject({ code: 20001, data: { fields: ['changes'] } });
  const empty = await f.controller
    .rollback(f.request, { keys: [], to_version: 0, expected_version: '0' })
    .catch((error: unknown) => error);
  expect(responseOf(empty)).toMatchObject({ code: 20001, data: { fields: ['keys'] } });
  expect(f.guard.calls).toEqual([]);
  expect(f.audits).toEqual([]);
});

it('[AC-F1-02t#u20] 资金术语写被守卫拒（10403 / 10003）：单独审计被拒键与拒绝码后原样抛出；其他类不记', async () => {
  for (const code of [10403, 10003]) {
    const f = fixture();
    f.guard.refuse = code;
    const refused = await f.controller
      .rollback(f.request, {
        keys: ['unclassified.test_key'],
        to_version: 0,
        expected_version: '0',
      })
      .catch((error: unknown) => error);
    expect(responseOf(refused)).toMatchObject({ code });
    expect(f.audits).toEqual([
      {
        appId: APP,
        actor: ADMIN,
        action: 'dict_items_denied',
        target: 'dict_items',
        before: null,
        after: { operation: 'rollback', keys: ['unclassified.test_key'], code, fund_terms: true },
        ip: '127.0.0.1',
      },
    ]);
    expect(f.work.calls).toBe(0);
    const general = fixture();
    general.guard.refuse = code;
    await general.controller
      .save(general.request, {
        changes: [{ key: 'about.copy_diagnostics', text: '甲' }],
        expected_version: '0',
      })
      .catch(() => undefined);
    expect(general.audits).toEqual([]);
  }
});

it('[AC-F1-02t#u21] 版本冲突映射为 409 / 20902，resource 为 dict_item', async () => {
  const f = fixture(true);
  const conflict = await f.controller
    .save(f.request, {
      changes: [{ key: 'about.copy_diagnostics', text: '甲' }],
      expected_version: '0',
    })
    .catch((error: unknown) => error);
  expect((conflict as HttpException).getStatus()).toBe(409);
  expect(responseOf(conflict)).toEqual({
    code: 20902,
    msg: '状态已变化，请刷新后重试',
    data: { resource: 'dict_item' },
    trace_id: 'trace-1',
  });
});
