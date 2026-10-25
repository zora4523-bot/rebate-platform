// B1-27c · re-registration after a request ended (contract adminCreateUserDataExport, the paragraph
// after point 3; 08 BR-ID-40 细则「截止时刻」「重新登记与登记人停用」; task §9 ④): when the user's latest
// request is failed, or a wecom_session one that expired without being delivered, the new request
// records it in retry_of and keeps its due_at (the time limit counts from the first registration and
// is not reopened); after any other ending (delivered, an expired in_app_sms request, an expired
// wecom_session request that was delivered) the new request has no retry_of and a fresh due_at.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY_MS,
  DUE_OF_NOW,
  HOUR_MS,
  at,
  copiesOf,
  copy,
  copyRow,
  inApp,
  jobs,
  ms,
  ok,
  register,
  registrant,
  setup,
  user,
  wecom,
  type CopyRow,
  type CopySeed,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

/** A due_at of an earlier registration (deliberately not the one NOW would give). */
const EARLIER_DUE = new Date(Date.parse('2026-11-17T16:00:00.000Z'));

type Ended = Omit<CopySeed, 'requestedBy'>;

const RETRIED: { case: string; ended: Ended }[] = [
  {
    case: '站内信路径生成失败（failed）',
    ended: { delivery: 'in_app_sms', status: 'failed' },
  },
  {
    case: '企业微信路径失败（failed，登记人停用）',
    ended: {
      delivery: 'wecom_session',
      status: 'failed',
      failureReason: '登记人后台账号已停用，请由接手的客服重新登记',
    },
  },
  {
    case: '企业微信路径没交付就过期（expired，delivered_at 为空）',
    ended: { delivery: 'wecom_session', status: 'expired', deliveredAt: null },
  },
];

it.each(RETRIED)(
  '[AC-B1-27c#31] 最近一条是$case → 新条 retry_of 记原条、due_at 沿用原条',
  async ({ ended }) => {
    const s = await setup(h);
    const target = await user(s);
    const by = await registrant(s);
    const previous = await copy(s, target, { requestedBy: by.id, dueAt: EARLIER_DUE, ...ended });
    const data = await ok(await register(s, target.id, inApp()));
    expect(data).toMatchObject({
      delivery: 'in_app_sms',
      status: 'pending',
      retry_of: previous.id,
      reused: false,
    });
    expect(ms(data.due_at)).toBe(EARLIER_DUE.getTime());
    const row = await copyRow(s, data.export_id);
    expect(row.retry_of).toBe(previous.id);
    expect(row.due_at.getTime()).toBe(EARLIER_DUE.getTime());
    // The ended request itself is not touched.
    expect(await copyRow(s, previous.id)).toEqual(previous);
    expect(jobs(s)).toHaveLength(1);
  },
);

const FRESH: { case: string; ended: Ended }[] = [
  {
    case: '站内信路径已交付（delivered）',
    ended: { delivery: 'in_app_sms', status: 'delivered', createdAt: at(-2 * HOUR_MS) },
  },
  {
    case: '站内信路径交付后过期（expired）',
    ended: {
      delivery: 'in_app_sms',
      status: 'expired',
      deliveredAt: at(-3 * DAY_MS + 3_600_000),
    },
  },
  {
    case: '企业微信路径交付后过期（expired，delivered_at 已有）',
    ended: {
      delivery: 'wecom_session',
      status: 'expired',
      deliveredAt: at(-3 * DAY_MS + 7_200_000),
    },
  },
  {
    case: '企业微信路径已交付（delivered）',
    ended: { delivery: 'wecom_session', status: 'delivered', createdAt: at(-2 * HOUR_MS) },
  },
];

it.each(FRESH)(
  '[AC-B1-27c#32] 最近一条是$case → 新条 retry_of 为空、due_at 从本次登记重新起算',
  async ({ ended }) => {
    const s = await setup(h);
    const target = await user(s);
    const by = await registrant(s);
    await copy(s, target, { requestedBy: by.id, dueAt: EARLIER_DUE, ...ended });
    const data = await ok(await register(s, target.id, inApp()));
    expect(data).toMatchObject({ status: 'pending', retry_of: null, reused: false });
    expect(ms(data.due_at)).toBe(Date.parse(DUE_OF_NOW));
    const row = await copyRow(s, data.export_id);
    expect(row.retry_of).toBeNull();
    expect(row.due_at.toISOString()).toBe(DUE_OF_NOW);
  },
);

/** Ended requests of `target`, oldest first, two days apart. */
async function history(s: Setup, target: User, seeds: Ended[]): Promise<CopyRow[]> {
  const by = await registrant(s);
  const rows: CopyRow[] = [];
  for (const [i, spec] of seeds.entries()) {
    rows.push(
      await copy(s, target, {
        requestedBy: by.id,
        createdAt: at((i - seeds.length) * 2 * DAY_MS, s.clock.now().toISOString()),
        ...spec,
      }),
    );
  }
  return rows;
}

it('[AC-B1-27c#33] 只看最近一条：较早的 failed 之后已交付过 → 不记 retry_of；较早已交付、最近 failed → 记最近那条', async () => {
  const s = await setup(h);
  const first = await user(s);
  await history(s, first, [
    { delivery: 'in_app_sms', status: 'failed', dueAt: EARLIER_DUE },
    { delivery: 'in_app_sms', status: 'delivered', dueAt: EARLIER_DUE },
  ]);
  const fresh = await ok(await register(s, first.id, inApp()));
  expect(fresh.retry_of).toBeNull();
  expect(ms(fresh.due_at)).toBe(Date.parse(DUE_OF_NOW));

  const second = await user(s);
  const [, latest] = await history(s, second, [
    { delivery: 'in_app_sms', status: 'delivered', dueAt: at(-10 * DAY_MS) },
    { delivery: 'in_app_sms', status: 'failed', dueAt: EARLIER_DUE },
  ]);
  const retried = await ok(await register(s, second.id, inApp()));
  expect(retried.retry_of).toBe(latest!.id);
  expect(ms(retried.due_at)).toBe(EARLIER_DUE.getTime());
});

it('[AC-B1-27c#34] 连续重登：最近一条 failed 本身也是重登的 → 新条 retry_of 记最近那条，due_at 仍是首次受理的截止时刻', async () => {
  const s = await setup(h);
  const target = await user(s);
  const by = await registrant(s);
  const origin = await copy(s, target, {
    requestedBy: by.id,
    delivery: 'wecom_session',
    status: 'expired',
    deliveredAt: null,
    dueAt: EARLIER_DUE,
    createdAt: at(-4 * DAY_MS),
  });
  const retry = await copy(s, target, {
    requestedBy: by.id,
    delivery: 'wecom_session',
    status: 'failed',
    retryOf: origin.id,
    dueAt: EARLIER_DUE,
    createdAt: at(-2 * DAY_MS),
  });
  const data = await ok(await register(s, target.id, wecom()));
  expect(data).toMatchObject({ delivery: 'wecom_session', retry_of: retry.id, reused: false });
  expect(ms(data.due_at)).toBe(EARLIER_DUE.getTime());
  expect(await copiesOf(s, target)).toHaveLength(3);
});
