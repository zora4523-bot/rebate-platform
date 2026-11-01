// B1-06zd rule tests: which registered links get a prefetch job (D10-510), through the real api
// entry and its running JOB_QUEUE: a job is a row of pgboss.job. Only a link registered by the
// product detail endpoint, never one a search page registered, for a logged-in user, of Taobao with
// a relation_id and a rebate, only while
// convert.taobao_prefetch.enabled is on and under its per-minute limit; over the limit it is
// skipped, never queued. The job goes out after the registration commits, without blocking the
// detail response; a failed delivery is only logged. A job's absence proves nothing by itself, so
// each case that expects none first or after shows a job of an eligible link in the same run.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { ENTRY_PLAN } from '../../../../apps/api/src/modules/platform/queue/catalog.ts';
import {
  JOB_NAME,
  NO_REBATE_RULE,
  PREFETCH_RATE,
  PREFETCH_SWITCH,
  QUEUE_NAME,
  cardOf,
  detailCard,
  expectJobsFor,
  promoHarness,
  type PromoTenant,
} from './kit.ts';

const h = promoHarness({ createTestDatabase, acquireTestRedis });
const ON = { [PREFETCH_SWITCH]: true };
/** Past the one-minute window, and past the 60-second content cache. */
const NEXT_MINUTE = '2026-10-30T02:01:01.000Z';

/** A logged-in user's detail of a Taobao card: the link that gets a job. */
async function eligibleDetail(t: PromoTenant): Promise<string> {
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));
  return String(detailCard(await member.detail(card)).link_id);
}

it.each([
  { label: '未配置', settings: {} },
  { label: '配置为 false', settings: { [PREFETCH_SWITCH]: false } },
])(
  '[AC-B1-06zd#13] convert.taobao_prefetch.enabled $label：详情不投任务；开关打开的 App 才投',
  async ({ settings }) => {
    const off = await h.tenant(settings);
    await eligibleDetail(off);

    const on = await h.tenant(ON);
    const linkId = await eligibleDetail(on);

    await expectJobsFor(h, on.appId, [linkId]);
    expect(await h.jobs(off.appId)).toEqual([]);
  },
  120_000,
);

it('[AC-B1-06zd#14] 详情登记的淘宝 link 投一个任务：payload 只有 app_id、link_id，任务在 worker 的队列上，详情本身不调联盟，快照记下该用户的 relation_id', async () => {
  const t = await h.tenant(ON);
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));

  const linkId = String(detailCard(await member.detail(card)).link_id);

  const jobs = await expectJobsFor(h, t.appId, [linkId]);
  expect(jobs[0]).toMatchObject({ queue: QUEUE_NAME });
  expect(jobs[0]!.payload).toEqual({ app_id: t.appId, link_id: linkId });
  expect(ENTRY_PLAN.worker.map((work) => work.queue)).toContain(QUEUE_NAME);
  expect(ENTRY_PLAN.api).toEqual([]);
  expect(h.conversions()).toEqual([]);
  const row = await h.link(linkId);
  expect(row).toMatchObject({
    entry_source: 'detail',
    promo_url: null,
    promo_url_fetched_at: null,
    identity_snapshot: { user_id: member.uid, relation_id: member.relationId },
  });
}, 120_000);

it('[AC-B1-06zd#15] 按详情接口登记判定：用卡片的 item_ref 请求详情，详情登记的淘宝 link 投一个任务，搜索列表登记的卡不投', async () => {
  const t = await h.tenant(ON);
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));

  expect(card.item_ref).toBeTypeOf('string');

  const linkId = String(detailCard(await member.detail(card)).link_id);

  expect(linkId).not.toBe(String(card.link_id));
  expect((await h.link(String(card.link_id))).entry_source).toBe('search');
  await expectJobsFor(h, t.appId, [linkId]);
}, 120_000);

it('[AC-B1-06zd#16] 只有淘宝：京东详情 link 不投', async () => {
  const t = await h.tenant(ON);
  const member = await t.user();
  const jd = cardOf(await member.search('jd'));
  const detail = detailCard(await member.detail(jd));

  const linkId = await eligibleDetail(t);

  expect((await h.link(String(detail.link_id))).entry_source).toBe('detail');
  await expectJobsFor(h, t.appId, [linkId]);
}, 120_000);

it('[AC-B1-06zd#17] 未登录（links.user_id 为空）不投', async () => {
  const t = await h.tenant(ON);
  const guest = await t.guest();
  const card = cardOf(await guest.search('taobao'));
  const detail = detailCard(await guest.detail(card));

  const linkId = await eligibleDetail(t);

  expect((await h.link(String(detail.link_id))).user_id).toBeNull();
  await expectJobsFor(h, t.appId, [linkId]);
}, 120_000);

it.each([
  { label: '没有绑定', options: { taobao: 'absent' as const } },
  { label: '绑定未生效', options: { taobao: 'invalid' as const } },
  { label: 'active 绑定没有 relation_id', options: { relationId: null } },
])(
  '[AC-B1-06zd#18] link 没有 relation_id（$label）不投',
  async ({ options }) => {
    const t = await h.tenant(ON);
    const member = await t.user(options);
    const card = cardOf(await member.search('taobao'));
    detailCard(await member.detail(card));

    const linkId = await eligibleDetail(t);

    await expectJobsFor(h, t.appId, [linkId]);
  },
  120_000,
);

it('[AC-B1-06zd#19] no_rebate 的详情卡不投', async () => {
  const t = await h.tenant(ON);
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));
  await t.setRule(NO_REBATE_RULE);
  h.clock.set(NEXT_MINUTE);
  const detail = detailCard(await member.detail(card));
  expect(detail.rebate_basis).toBe('no_rebate');

  const other = await h.tenant(ON);
  const linkId = await eligibleDetail(other);

  await expectJobsFor(h, other.appId, [linkId]);
  expect(await h.jobs(t.appId)).toEqual([]);
}, 120_000);

it('[AC-B1-06zd#20] 每分钟上限：超限跳过、不排队，下一分钟恢复；上限按 App 各算各的', async () => {
  const settings = { ...ON, [PREFETCH_RATE]: 2 };
  const t = await h.tenant(settings);
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));
  const links: string[] = [];
  for (let n = 0; n < 3; n += 1) {
    links.push(String(detailCard(await member.detail(card)).link_id));
  }
  await vi.waitFor(async () => expect(await h.jobs(t.appId)).toHaveLength(2), {
    timeout: 5_000,
    interval: 50,
  });

  // The same minute, another App: its own limit, untouched by the first App's.
  const other = await h.tenant(settings);
  await expectJobsFor(h, other.appId, [await eligibleDetail(other)]);

  h.clock.set(NEXT_MINUTE);
  const later = String(detailCard(await member.detail(card)).link_id);
  await vi.waitFor(
    async () => {
      const jobs = await h.jobs(t.appId);
      expect(jobs.map((job) => job.payload['link_id'])).toContain(later);
    },
    { timeout: 5_000, interval: 50 },
  );
  // The skipped link was never queued: it did not come back with the new minute.
  expect(await h.jobs(t.appId)).toHaveLength(3);
}, 120_000);

it('[AC-B1-06zd#21] 投递失败只记日志：详情照常 200，link 已登记', async () => {
  const t = await h.tenant(ON);
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));
  const send = h.interceptSend(() => Promise.reject(new Error('synthetic send failure')));

  const linkId = String(detailCard(await member.detail(card)).link_id);

  await vi.waitFor(
    () => expect(send.mock.calls.filter((call) => call[1] === JOB_NAME)).toHaveLength(1),
    { timeout: 5_000, interval: 50 },
  );
  await vi.waitFor(() => expect(h.warnings().length).toBeGreaterThan(0), {
    timeout: 5_000,
    interval: 50,
  });
  expect(await h.link(linkId)).toMatchObject({ user_id: member.uid, promo_url: null });
}, 120_000);

it('[AC-B1-06zd#22] 不阻塞详情：投递迟迟不回，详情照样答复；投递在登记提交之后、不进登记事务，也不带 singletonKey', async () => {
  const t = await h.tenant(ON);
  const member = await t.user();
  const card = cardOf(await member.search('taobao'));
  const visible: string[] = [];
  const send = h.interceptSend(async (_queue, _name, payload) => {
    const rows = await h
      .db()
      .selectFrom('links')
      .select('link_id')
      .where('link_id', '=', String(payload['link_id']))
      .execute();
    visible.push(...rows.map((row) => row.link_id));
    return new Promise<string | null>(() => undefined);
  });

  const answered = await Promise.race([member.detail(card), sleep(3_000, 'held' as const)]);

  expect(answered).not.toBe('held');
  if (answered === 'held') return;
  const linkId = String(detailCard(answered).link_id);
  await vi.waitFor(() => expect(visible).toEqual([linkId]), { timeout: 5_000, interval: 50 });
  const call = send.mock.calls.find((entry) => entry[1] === JOB_NAME);
  expect(call).toBeDefined();
  const options = call![3];
  expect(options.trx).toBeNull();
  expect(options).not.toHaveProperty('singletonKey');
}, 120_000);
