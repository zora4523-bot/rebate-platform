// B1-27c · the list of one user's copy requests (contract adminListUserDataExports; 04 §6.6): every
// request of the user whoever registered it, newest first (created_at descending), page by page with
// the total; each row's status, delivery, due_at, expires_at and retry_of as stored, the registrant's
// current name (display_name, else the username); never a link, an object key, an extraction code
// or a password; listing writes no audit record.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY_MS,
  HOUR_MS,
  allAudits,
  at,
  copy,
  list,
  listed,
  ms,
  registrant,
  rowText,
  setup,
  user,
  type CopyRow,
  type Listed,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

/** The list row of `row`, the registrant shown as `name`. */
function expectItem(item: Listed | undefined, row: CopyRow, name: string) {
  expect(item, `列表应含 ${row.id}`).toBeDefined();
  expect(item).toMatchObject({
    export_id: row.id,
    user_id: row.user_id,
    delivery: row.delivery,
    status: row.status,
    requested_by: row.requested_by,
    requested_by_name: name,
    retry_of: row.retry_of,
    failure_reason: row.failure_reason,
  });
  expect(ms(item!.created_at)).toBe(row.created_at.getTime());
  expect(ms(item!.due_at)).toBe(row.due_at.getTime());
  expect(ms(item!.generated_at)).toBe(ms(row.generated_at));
  expect(ms(item!.delivered_at)).toBe(ms(row.delivered_at));
  expect(ms(item!.expires_at)).toBe(ms(row.expires_at));
}

/** Four requests of `target` by two registrants, oldest first, a day apart. */
async function history(s: Setup, target: User) {
  const named = await registrant(s, { displayName: '客服小周' });
  const plain = await registrant(s);
  const base = s.clock.now().toISOString();
  const failed = await copy(s, target, {
    requestedBy: named.id,
    delivery: 'wecom_session',
    status: 'failed',
    failureReason: '登记人后台账号已停用，请由接手的客服重新登记',
    createdAt: at(-4 * DAY_MS, base),
    dueAt: at(18 * DAY_MS, base),
  });
  const expired = await copy(s, target, {
    requestedBy: plain.id,
    delivery: 'wecom_session',
    status: 'expired',
    retryOf: failed.id,
    deliveredAt: null,
    createdAt: at(-3 * DAY_MS, base),
    dueAt: at(18 * DAY_MS, base),
  });
  const delivered = await copy(s, target, {
    requestedBy: named.id,
    delivery: 'in_app_sms',
    status: 'delivered',
    createdAt: at(-2 * HOUR_MS, base),
    dueAt: at(19 * DAY_MS, base),
  });
  const pending = await copy(s, target, {
    requestedBy: plain.id,
    delivery: 'in_app_sms',
    status: 'pending',
    createdAt: at(-HOUR_MS, base),
    dueAt: at(20 * DAY_MS, base),
  });
  return {
    rows: [pending, delivered, expired, failed],
    names: { [named.id]: '客服小周', [plain.id]: plain.username } as Record<string, string>,
  };
}

it('[AC-B1-27c#35] 列出该用户全部请求（不论谁登记），按 created_at 倒序，字段照库里的值，登记人名取 display_name 否则用户名', async () => {
  const s = await setup(h);
  const target = await user(s);
  const other = await user(s);
  const { rows, names } = await history(s, target);
  await copy(s, other, { requestedBy: s.actor.id, status: 'pending' });
  const page = await listed(await list(s, target.id));
  expect(page).toMatchObject({ page: 1, page_size: 20, total: 4 });
  expect(page.items.map((item) => item.export_id)).toEqual(rows.map((row) => row.id));
  for (const [i, row] of rows.entries()) expectItem(page.items[i], row, names[row.requested_by]!);
});

it('[AC-B1-27c#36] 分页：page_size=3 时第 1 页 3 条、第 2 页 1 条、第 3 页为空，total 都是 4', async () => {
  const s = await setup(h);
  const target = await user(s);
  const { rows } = await history(s, target);
  const first = await listed(await list(s, target.id, '?page=1&page_size=3'));
  expect(first).toMatchObject({ page: 1, page_size: 3, total: 4 });
  expect(first.items.map((item) => item.export_id)).toEqual(rows.slice(0, 3).map((row) => row.id));
  const second = await listed(await list(s, target.id, '?page=2&page_size=3'));
  expect(second).toMatchObject({ page: 2, page_size: 3, total: 4 });
  expect(second.items.map((item) => item.export_id)).toEqual([rows[3]!.id]);
  const third = await listed(await list(s, target.id, '?page=3&page_size=3'));
  expect(third).toEqual({ items: [], page: 3, page_size: 3, total: 4 });
});

it('[AC-B1-27c#37] 列表不带对象键、链接、提取码或口令，也不写审计', async () => {
  const s = await setup(h);
  const target = await user(s);
  const by = await registrant(s);
  const key = `data-copies/${s.appId}/${target.id}/run-key-b127c.zip`;
  const ready = await copy(s, target, {
    requestedBy: by.id,
    delivery: 'wecom_session',
    status: 'ready',
    createdAt: at(-HOUR_MS),
    objectKey: key,
  });
  const before = await allAudits(s);
  const response = await list(s, target.id);
  const page = await listed(response);
  expect(page.items.map((item) => item.export_id)).toEqual([ready.id]);
  const text = rowText(response.json());
  expect(text).not.toContain(key);
  expect(text).not.toContain('run-key-b127c');
  for (const item of page.items) {
    expect(Object.keys(item)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/key|url|link|code|password|secret/i)]),
    );
  }
  expect(await allAudits(s)).toEqual(before);
});
