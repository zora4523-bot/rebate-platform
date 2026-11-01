// B2-08e · listing, downloading and retrying tax tasks (规划/08 BR-WDR-21; contract adminListExports,
// adminDownloadExport, adminRetryExport; D10-546; task §9.11, §9.12). Files come from the real worker
// entry, links from the real export store; another account's task is created over HTTP by that
// account, because the table only takes a tax task the implementation has opened.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { OLD, user, verified } from '../../identity/admin-realname/kit.ts';
import { grant, seed } from '../accounts/kit.ts';
import { signedIn } from '../auth/kit.ts';
import {
  DOWNLOAD,
  error,
  LIST,
  ok,
  RETRY,
  text,
  type Download,
  type Page,
  type View,
} from '../exports/kit.ts';
import {
  authFixture,
  colleague,
  COLUMN,
  DAY_MS,
  DENIED,
  FULL,
  FULL_POINT,
  harness,
  LINK_TTL_MS,
  MASKED,
  MASKED_POINTS,
  open,
  paid,
  person,
  PURPOSE,
  rowOf,
  started,
  type Tax,
} from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

/** A done task over one member (one per test: a verified id number is unique in an app). */
async function doneTask(f: Tax, body: typeof MASKED | typeof FULL = FULL) {
  const withdrawal = await paid(h, await person(h, f.appId, OLD));
  const step = body === FULL ? await f.token() : undefined;
  const view = await ok<View>(await f.create(body, step));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 1 });
  return { view, withdrawal };
}

/** A failed task: a member without a real name in the quarter fails the generation. */
async function failedTask(f: Tax, body: typeof MASKED | typeof FULL = FULL) {
  const member = await user(h, f.appId);
  const withdrawal = await paid(h, member);
  const step = body === FULL ? await f.token() : undefined;
  const view = await ok<View>(await f.create(body, step));
  expect((await f.generate(view.id)).status).toBe('failed');
  return { view, member, withdrawal };
}

it('[AC-B2-08e#30] 只持 tax.export_full：列表只见本人 tax_withdrawals，看不到别的 resource 与别人的任务', async () => {
  const f = await open(h, [FULL_POINT]);
  const other = await colleague(h, f, MASKED_POINTS);
  await ok<View>(await f.request('POST', LIST, MASKED, undefined, other.token));
  const own = await ok<View>(await f.create(FULL, await f.token()));
  await f.task({ resource: 'users' });
  await f.task({ resource: 'audit_logs' });
  const page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.total).toBe(1);
  expect(page.items.map((item) => item.id)).toEqual([own.id]);
  const hidden = await ok<Page>(await f.list('?resource=users'), LIST, 'get');
  expect(hidden).toMatchObject({ total: 0, items: [] });
  const tax = await ok<Page>(await f.list('?resource=tax_withdrawals'), LIST, 'get');
  expect(tax.items.map((item) => item.id)).toEqual([own.id]);
  expect(text(page)).not.toMatch(/object_key|signature/);
});

it('[AC-B2-08e#44] tax.export_full 加 audit.view_all 但无 export：列表仍只见本人 tax_withdrawals', async () => {
  const f = await open(h, [FULL_POINT, 'audit.view_all']);
  const other = await colleague(h, f, MASKED_POINTS);
  await ok<View>(await f.request('POST', LIST, MASKED, undefined, other.token));
  const own = await ok<View>(await f.create(FULL, await f.token()));
  expect(await f.tasks()).toHaveLength(2);
  for (const query of ['', '?resource=tax_withdrawals']) {
    const page = await ok<Page>(await f.list(query), LIST, 'get');
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([own.id]);
  }
});

it('[AC-B2-08e#31] 持 export 的账号照常看见本人全部 resource 的任务', async () => {
  const f = await open(h, MASKED_POINTS);
  const own = await ok<View>(await f.create(MASKED));
  const users = await f.task({ resource: 'users' });
  const page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.items.map((item) => item.id).sort()).toEqual([own.id, users.public_id].sort());
});

it('[AC-B2-08e#32] 只持 tax.export_full 能下载本人全量文件：现签 5 分钟链接、no-store、审计，不需新令牌', async () => {
  const f = await started(h, [FULL_POINT]);
  const { view, withdrawal } = await doneTask(f);
  const before = f.clock.now().getTime();
  const audits = await f.audits();
  const response = await f.download(view.id);
  const data = await ok<Download>(response, DOWNLOAD, 'get');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(new Date(data.url_expires_at).getTime()).toBe(before + LINK_TTL_MS);
  const { store } = await f.entry();
  expect(data.url).toContain(`/${f.appId}/${view.id}.csv?`);
  expect(store.verify(data.url, f.clock.now())).toBe(true);
  expect(rowOf(await f.file(view.id), withdrawal.out_biz_no)[COLUMN.idNo]).toBe(OLD.idNo);
  const added = (await f.audits()).slice(audits.length);
  expect(added).toEqual([
    expect.objectContaining({
      action: 'export_download',
      admin_id: f.actor.id,
      after: expect.objectContaining({
        task_id: view.id,
        resource: 'tax_withdrawals',
        masked: false,
      }),
    }),
  ]);
  expect(text(added)).not.toContain(data.url);
});

it('[AC-B2-08e#33] 只持 tax.export_full 能重试本人失败的全量任务：要新 reason 与新令牌，生成后审计记新用途', async () => {
  const f = await started(h, [FULL_POINT]);
  const { view, member, withdrawal } = await failedTask(f);
  await verified(h, member, OLD);
  const reason = '补齐实名后重新申报';
  const token = await f.token();
  await error(await f.retry(view.id, {}, token), 20001, { fields: ['reason'] }, RETRY);
  await error(await f.retry(view.id, { reason }), 10003, { tier: 'totp' }, RETRY);
  const retried = await ok<View>(await f.retry(view.id, { reason }, token), RETRY);
  expect(retried).toMatchObject({
    id: view.id,
    resource: 'tax_withdrawals',
    masked: false,
    status: 'pending',
    failure_reason: null,
  });
  const audits = await f.audits();
  expect(audits.map((audit) => audit.action).slice(-2)).toEqual([
    'export_retry',
    'export_unmasked',
  ]);
  expect(audits.at(-1)).toMatchObject({ after: expect.objectContaining({ reason }) });
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 1 });
  expect(rowOf(await f.file(view.id), withdrawal.out_biz_no)[COLUMN.idNo]).toBe(OLD.idNo);
  expect((await f.audits()).at(-1)).toMatchObject({
    action: 'export_unmasked',
    after: expect.objectContaining({ reason, row_count: 1 }),
  });
  expect(text(await f.audits())).toContain(PURPOSE);
});

it.each(['download', 'retry'] as const)(
  '[AC-B2-08e#34] 只持 tax.export_full 的 %s：别人的任务、未知 id、外 App、本人别的 resource 一律 20001 [id]',
  async (operation) => {
    const f = await open(h, [FULL_POINT]);
    const other = await colleague(h, f, MASKED_POINTS);
    const theirs = await ok<View>(await f.request('POST', LIST, MASKED, undefined, other.token));
    const foreign = await seed(h, 'foreign_tax_export');
    const elsewhere = await f.task({ app_id: foreign.appId, created_by: foreign.id });
    const ownUsers = await f.task({ resource: 'users' });
    const before = await f.audits();
    const ids = [theirs.id, 'exp_UnknownTaskForNoProbing', elsewhere.public_id, ownUsers.public_id];
    for (const id of ids) {
      if (operation === 'download') {
        await error(await f.download(id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
      } else {
        await error(await f.retry(id), 20001, { fields: ['id'] }, RETRY);
      }
    }
    expect(f.sign).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual(before);
  },
);

// audit_logs has no source point to lose: when tax.export_full is all that opens the door, only the
// task's resource can refuse. The first download shows the task itself is downloadable.
it('[AC-B2-08e#34] 下载：本人 done 的 audit_logs 任务，失去 export、获得 tax.export_full 后 20001 [id]，不签链接', async () => {
  const f = await started(h, ['export']);
  const view = await ok<View>(await f.create({ resource: 'audit_logs', filters: {} }));
  expect(await f.generate(view.id)).toMatchObject({ status: 'done' });
  await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
  await f.revoke('export');
  await grant(h, f.actor, f.actor, [FULL_POINT]);
  const audits = await f.audits();
  await error(await f.download(view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(await f.audits()).toEqual(audits);
});

it('[AC-B2-08e#35] audit.view_all 只放宽列表：能看见别人的 tax 任务，下载仍 20001 [id]', async () => {
  const f = await open(h, [...MASKED_POINTS, 'audit.view_all']);
  const other = await colleague(h, f, MASKED_POINTS);
  const theirs = await ok<View>(await f.request('POST', LIST, MASKED, undefined, other.token));
  const page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.items.map((item) => item.id)).toEqual([theirs.id]);
  await error(await f.download(theirs.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).not.toHaveBeenCalled();
});

it('[AC-B2-08e#36] 只持 tax.export_full 的账号失去该点：全量文件取不到（10403），不签链接', async () => {
  const f = await started(h, [FULL_POINT]);
  const { view } = await doneTask(f);
  await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
  await f.revoke(FULL_POINT);
  await error(await f.download(view.id), 10403, DENIED, DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
});

// With fund.view kept, only the full file's own point can refuse: fund.view alone must not pass it.
it.each([[['export', FULL_POINT]], [[...MASKED_POINTS, FULL_POINT]]] as const)(
  '[AC-B2-08e#37] 持 %j 的创建人失去 tax.export_full：全量文件 20001 [id]，重试 10403',
  async (points) => {
    const f = await started(h, points);
    const done = await doneTask(f);
    const failed = await failedTask(f);
    const reason = '失去权限后再试';
    const token = await f.token();
    await f.revoke(FULL_POINT);
    const audits = await f.audits();
    await error(await f.download(done.view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
    await error(await f.retry(failed.view.id, { reason }, token), 10403, DENIED, RETRY);
    expect(f.sign).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual(audits);
  },
);

it('[AC-B2-08e#38] 脱敏文件按 fund.view 复查：失去后下载 20001 [id]，重试 10403', async () => {
  const f = await started(h);
  const done = await doneTask(f, MASKED);
  const failed = await failedTask(f, MASKED);
  await ok<Download>(await f.download(done.view.id), DOWNLOAD, 'get');
  await f.revoke('fund.view');
  await error(await f.download(done.view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  await error(await f.retry(failed.view.id), 10403, DENIED, RETRY);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it('[AC-B2-08e#39] 只剩 tax.export_full 时本人的脱敏文件也取不到：20001 [id]', async () => {
  const f = await started(h, [...MASKED_POINTS, FULL_POINT]);
  const { view } = await doneTask(f, MASKED);
  await f.revoke('export');
  await f.revoke('fund.view');
  await error(await f.download(view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).not.toHaveBeenCalled();
});

it('[AC-B2-08e#40] 脱敏任务失败后补齐实名可重试：空 body、不要令牌，带 reason 20001', async () => {
  const f = await started(h);
  const { view, member, withdrawal } = await failedTask(f, MASKED);
  await verified(h, member, OLD);
  await error(await f.retry(view.id, { reason: '多余' }), 20001, { fields: ['reason'] }, RETRY);
  const retried = await ok<View>(await f.retry(view.id, {}, 'ignored-invalid-token'), RETRY);
  expect(retried).toMatchObject({ id: view.id, masked: true, status: 'pending' });
  expect(await f.generate(view.id)).toMatchObject({ status: 'done', row_count: 1 });
  expect(rowOf(await f.file(view.id), withdrawal.out_biz_no)[COLUMN.name]).toBe(OLD.name);
});

it('[AC-B2-08e#41] 每次下载重新签发、重新鉴权并各记审计，链接 5 分钟有效，过期后旧链接失效', async () => {
  const f = await started(h);
  const { view } = await doneTask(f, MASKED);
  const { store } = await f.entry();
  const first = await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  f.clock.advanceMs(60_000);
  const second = await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  expect(second.url).not.toBe(first.url);
  expect(new Date(second.url_expires_at).getTime()).toBe(f.clock.now().getTime() + LINK_TTL_MS);
  expect(f.sign).toHaveBeenCalledTimes(2);
  const downloads = (await f.audits()).filter((audit) => audit.action === 'export_download');
  expect(downloads).toHaveLength(2);
  f.clock.advanceMs(LINK_TTL_MS - 60_000);
  expect(store.verify(first.url, f.clock.now())).toBe(false);
  expect(store.verify(second.url, f.clock.now())).toBe(true);
});

it('[AC-B2-08e#42] 文件保留 24 小时：临近到期链接截到 expires_at，到期 30417 expired，expire 任务删对象', async () => {
  const f = await started(h);
  const { view } = await doneTask(f, MASKED);
  const row = (await f.tasks()).find((task) => task.public_id === view.id)!;
  expect(row.expires_at!.getTime() - row.generated_at!.getTime()).toBe(DAY_MS);
  const { sent, store } = await f.entry();
  const expiries = sent.mock.calls.filter(([, name]) => name === 'expire');
  expect(expiries).toEqual([
    [
      'export',
      'expire',
      { appId: f.appId, taskId: row.id },
      expect.objectContaining({ trx: expect.anything(), delaySeconds: DAY_MS / 1000 }),
    ],
  ]);
  f.clock.set(new Date(row.expires_at!.getTime() - 60_000));
  // A day on, the first session is past its idle limit and lifetime: sign in again.
  const { admin_token: token } = await signedIn(authFixture(f), f.actor);
  const download = () =>
    f.request('GET', `${LIST}/${view.id}/download`, undefined, undefined, token);
  const last = await ok<Download>(await download(), DOWNLOAD, 'get');
  expect(new Date(last.url_expires_at).getTime()).toBe(row.expires_at!.getTime());
  f.clock.set(row.expires_at!);
  await error(await download(), 30417, { status: 'expired' }, DOWNLOAD, 'get');
  expect(await f.expire(view.id)).toMatchObject({ status: 'expired' });
  expect(store.get(row.object_key!)).toBeUndefined();
});

it('[AC-B2-08e#43] 超管创建的全量文件能下载，无需逐项勾选', async () => {
  const f = await started(h, [], true);
  const { view } = await doneTask(f);
  await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
});
