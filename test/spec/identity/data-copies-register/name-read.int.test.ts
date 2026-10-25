// B1-27c · the registrant's name read failing (regression of code review r1, fixed in 61f9a884):
// requested_by_name is display only (contract: null when it cannot be read), so a failing read
// must never decide whether the registration is kept. The entry runs on a handle whose plugin
// turns admin's display name read (admin_users id / login_name / display_name by ANY(ids)) into
// a statement Postgres itself rejects (division by zero), on the root handle and on transactions
// alike: were the read made inside the registration's transaction and its error swallowed, the
// transaction would be aborted and its COMMIT a silent ROLLBACK. Whatever the entry answers, a 2xx
// means the request, its generate job and its audit record are in the database; the current
// implementation reads the name after the commit, so the registration stands with the name null.
import type { DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin, type RootOperationNode } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Harness, type Response } from '../../admin/auth/kit.ts';
import {
  DUE_OF_NOW,
  GENERATE,
  QUEUE,
  REASON,
  WECOM_REASON,
  added,
  audits,
  copiesOf,
  copy,
  expectRequestAudit,
  inApp,
  jobs,
  list,
  listed,
  ms,
  ok,
  queuedJobs,
  register,
  registrant,
  rowText,
  setup,
  user,
  wecom,
  type AuditRow,
  type CopyRow,
  type Registered,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

/** admin's display name read (admin/infra/admin-display-names.ts), as compiled SQL. */
function isNameRead(text: string): boolean {
  const flat = text.replaceAll('"', '').toLowerCase();
  return (
    flat.startsWith('select') &&
    /\bfrom\s+(?:app\.)?admin_users\b/.test(flat) &&
    flat.includes('display_name') &&
    flat.includes('login_name') &&
    flat.includes('any(')
  );
}

/**
 * The harness with its handle wrapped: while armed, every display name read is replaced by a
 * statement that fails in Postgres (22012), so a transaction it runs on is aborted.
 */
function failingNameRead(base: Harness) {
  const state = { armed: false, fired: 0 };
  const executor = base.db.getExecutor();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }): RootOperationNode {
      if (!state.armed) return node;
      if (!isNameRead(executor.compileQuery(node, queryId).sql)) return node;
      state.fired += 1;
      return sql`select 1 / 0 as id`.toOperationNode();
    },
    async transformResult({ result }) {
      return result;
    },
  };
  const db: Kysely<DB> = base.db.withPlugin(plugin);
  const harness: Harness = { ...base, db };
  return { harness, state };
}

interface Before {
  readonly rows: readonly CopyRow[];
  readonly audits: readonly AuditRow[];
  readonly jobs: number;
  readonly queued: number;
}

async function snapshot(s: Setup, target: User): Promise<Before> {
  return {
    rows: await copiesOf(s, target),
    audits: await audits(s),
    jobs: jobs(s).length,
    queued: await queuedJobs(s),
  };
}

/**
 * Either outcome is allowed, never a mixed one: a 2xx leaves the answered request in the database
 * with one new audit record naming it (and, when new, its generate job enqueued); a 5xx leaves no
 * new request, job or audit record.
 */
async function expectAllOrNothing(
  s: Setup,
  target: User,
  response: Response,
  before: Before,
): Promise<void> {
  const rows = await copiesOf(s, target);
  const newAudits = added(before.audits, await audits(s));
  if (response.statusCode >= 200 && response.statusCode < 300) {
    const data = response.json<{ data: Registered }>().data;
    expect(
      rows.some((row) => row.id === data.export_id),
      '接口回成功时库里必须有该请求',
    ).toBe(true);
    expect(newAudits, '接口回成功时必须有这次登记的审计').toHaveLength(1);
    expect(rowText(newAudits[0])).toContain(data.export_id);
    if (data.reused) {
      expect(jobs(s).length).toBe(before.jobs);
      expect(await queuedJobs(s)).toBe(before.queued);
    } else {
      expect(rows).toHaveLength(before.rows.length + 1);
      expect(
        jobs(s)
          .slice(before.jobs)
          .some((job) => job.name === GENERATE && job.payload['copyId'] === data.export_id),
        '接口回成功时必须已入队 generate',
      ).toBe(true);
      expect(await queuedJobs(s)).toBe(before.queued + 1);
    }
    return;
  }
  expect(response.statusCode, JSON.stringify(response.json())).toBeGreaterThanOrEqual(500);
  expect(rows).toEqual(before.rows);
  expect(newAudits).toEqual([]);
  expect(await queuedJobs(s)).toBe(before.queued);
}

/** Registers with the display name read failing in Postgres for the duration of the call. */
async function registerFailingName(
  s: Setup,
  state: { armed: boolean; fired: number },
  target: User,
  payload: Record<string, unknown>,
) {
  state.armed = true;
  try {
    return await register(s, target.id, payload);
  } finally {
    state.armed = false;
  }
}

it.each([
  { case: 'in_app_sms', delivery: 'in_app_sms', phone: undefined, reason: REASON },
  { case: 'wecom_session', delivery: 'wecom_session', phone: null, reason: WECOM_REASON },
] as const)(
  '[AC-B1-27c#38] 登记人显示名读取在数据库层失败（$case）：登记照常提交——2xx、pending 行、一条 generate、一条审计俱在，requested_by_name 为 null',
  async ({ delivery, phone, reason }) => {
    const { harness, state } = failingNameRead(h);
    const s = await setup(harness);
    const target = await user(s, phone === null ? { phone: null } : {});
    const payload = delivery === 'in_app_sms' ? inApp() : wecom();
    const before = await snapshot(s, target);

    const response = await registerFailingName(s, state, target, payload);
    expect(state.fired, '显示名读取必须真的被注入失败').toBeGreaterThanOrEqual(1);
    await expectAllOrNothing(s, target, response, before);

    // The current implementation reads the name after the commit: the registration stands.
    const data = await ok(response);
    expect(data).toMatchObject({
      user_id: target.id,
      delivery,
      status: 'pending',
      requested_by: s.actor.id,
      requested_by_name: null,
      retry_of: null,
      reused: false,
    });
    expect(ms(data.due_at)).toBe(Date.parse(DUE_OF_NOW));

    const rows = await copiesOf(s, target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: data.export_id,
      app_id: s.appId,
      user_id: target.id,
      requested_by: s.actor.id,
      delivery,
      status: 'pending',
    });
    expect(jobs(s)).toEqual([
      {
        queue: QUEUE,
        name: GENERATE,
        payload: { appId: s.appId, copyId: data.export_id },
        inTransaction: true,
        insideStatus: 'pending',
        visibleOutside: false,
      },
    ]);
    expect(await queuedJobs(s)).toBe(1);
    const auditRows = await audits(s);
    expect(auditRows).toHaveLength(1);
    expectRequestAudit(s, auditRows[0], {
      admin: s.actor.id,
      user: target,
      reason,
      channels: delivery === 'in_app_sms' ? { app: true, sms: true } : { app: false, sms: false },
      contains: [data.export_id],
    });

    // With the read working again the same request shows its registrant's name.
    const page = await listed(await list(s, target.id));
    expect(page.items.map((item) => item.export_id)).toEqual([data.export_id]);
    expect(typeof page.items[0]?.requested_by_name).toBe('string');
  },
);

it('[AC-B1-27c#39] 复用原条时显示名读取在数据库层失败：仍回原条 reused=true、requested_by_name 为 null，原条不变、不入队、照常写一条审计', async () => {
  const { harness, state } = failingNameRead(h);
  const s = await setup(harness);
  const target = await user(s);
  const earlier = await registrant(s, { displayName: '客服小林' });
  const open = await copy(s, target, { requestedBy: earlier.id, status: 'pending' });
  const before = await snapshot(s, target);

  const response = await registerFailingName(s, state, target, inApp());
  expect(state.fired, '显示名读取必须真的被注入失败').toBeGreaterThanOrEqual(1);
  await expectAllOrNothing(s, target, response, before);

  const data = await ok(response);
  expect(data).toMatchObject({
    export_id: open.id,
    user_id: target.id,
    status: 'pending',
    requested_by: earlier.id,
    requested_by_name: null,
    reused: true,
  });
  expect(await copiesOf(s, target)).toEqual(before.rows);
  expect(jobs(s)).toEqual([]);
  expect(await queuedJobs(s)).toBe(0);
  const auditRows = await audits(s);
  expect(auditRows).toHaveLength(1);
  expectRequestAudit(s, auditRows[0], {
    admin: s.actor.id,
    user: target,
    reason: REASON,
    channels: { app: true, sms: true },
    contains: [open.id],
  });

  const page = await listed(await list(s, target.id));
  expect(page.items[0]).toMatchObject({ export_id: open.id, requested_by_name: '客服小林' });
});
