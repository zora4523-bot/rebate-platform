// 规则测试共用（B1-22t；编排裁定 D10-434 ①；08 BR-ID-24 ② 告警短信同一号码、同一到期时刻、同一阶段只发
// 一次，SPEC_REF 37808a5）。
// - 站长告警短信行（notify_logs，user_id 空、channel sms、dedupe_key `union_auth:…`）每次领取都有自己的
//   领取标识；不加列时就是领取写入的 updated_at 精确值（注入时钟）。
// - 发送结果落定、发送抛错退回 queued、未决恢复的查询结果，都只在该行仍是本次领取时生效（compare-and-set）；
//   否则什么都不改，只记一条 warn（level 40，带 app_id 与 union_account_id，不含号码明文），不记 error。
// - 现有状态编码不变（B1-22b）：queued ∧ row_version 0 待发；failed ∧ sent_at 空 ∧ row_version 1 已领取
//   未落定（10 分钟后可恢复）；row_version 2 落定。
// 替身发送器的每次 send / query 都挂起，直到用例显式给出结果，由此排出「A 挂起 → 超 10 分钟 → B 恢复领取 →
// A 迟到」。期望值按规则手写，不取自实现。这里不引用测试库基座（@couli/db/testing）：只有 *.int.test.ts 可以。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createSiteAuthAlertPort,
  type SiteAuthAlertPlan,
  type TemplateSmsMessage,
  type TemplateSmsQueryResult,
  type TemplateSmsResult,
  type TemplateSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import { memoryLogger, waitFor } from '../../platform/queue/kit.ts';

export const NOW = '2026-12-16T01:00:00.000Z';
export const EXPIRES = '2026-12-23T01:00:00.000Z';
/** 合成号码与它的盲索引（只是一个不含冒号的不透明串）。 */
export const PHONE = '13700137000';
export const PHONE_ID = 'b1-22t-synthetic-phone-index-0001';
/** 超过未决恢复时限（10 分钟）：此前的领取可被恢复。 */
export const RECOVER_MS = 11 * 60_000;
/** 两步之间推进的时间（远小于 10 分钟：新领取仍新鲜）。 */
export const STEP_MS = 60_000;
const WAIT_MS = 10_000;

type QueryInput = Parameters<NonNullable<TemplateSmsSender['query']>>[0];

/** 一次挂起的发送器调用：用例用 resolve / reject 给出结果。 */
export interface HeldCall<I, O> {
  readonly input: I;
  readonly resolve: (value: O) => void;
  readonly reject: (error: Error) => void;
}

function held<I, O>() {
  const calls: HeldCall<I, O>[] = [];
  const call = (input: I) =>
    new Promise<O>((resolve, reject) => {
      calls.push({ input, resolve, reject });
    });
  return { calls, call };
}

/** 每次 send / query 都挂起的发送器；withQuery = false 时没有 query（恢复即重发）。 */
export function heldSender(withQuery: boolean) {
  const send = held<TemplateSmsMessage, TemplateSmsResult>();
  const query = held<QueryInput, TemplateSmsQueryResult>();
  const sender: TemplateSmsSender = withQuery
    ? { send: send.call, query: query.call }
    : { send: send.call };
  return { sender, sends: send.calls, queries: query.calls };
}

/** 一次交付的结局（不 await：有的交付要挂起到用例给出发送结果）。 */
export interface Tracked {
  state: 'pending' | 'resolved' | 'rejected';
}

export function track(promise: Promise<unknown>): Tracked {
  const tracked: Tracked = { state: 'pending' };
  void promise.then(
    () => {
      tracked.state = 'resolved';
    },
    () => {
      tracked.state = 'rejected';
    },
  );
  return tracked;
}

/** 轮询到 ready 为真；限时内不为真是断言失败（不是超时）。 */
export async function until(ready: () => boolean, label: string): Promise<void> {
  expect(await waitFor(ready, WAIT_MS), label).toBe(true);
}

/** 一个 app、一个淘宝联盟账号、一个号码、一行 d7 到期提醒（queued）。 */
export async function harness(db: Kysely<DB>, options: { query: boolean }) {
  const appId = `site-alert-claim-${randomUUID()}`;
  const accountId = randomUUID();
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger('worker');
  const sms = heldSender(options.query);
  const port = createSiteAuthAlertPort({ db, clock, logger, sms: sms.sender });
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic site',
      status: 'active',
      auth_status: 'active',
      auth_expires_at: EXPIRES,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const plan: SiteAuthAlertPlan = {
    appId,
    unionAccountId: accountId,
    platform: 'taobao',
    authExpiresAt: new Date(EXPIRES),
    stage: 'd7',
    code: 'UNION_AUTH_EXPIRING',
    phoneIds: [PHONE_ID],
  };
  expect(await db.transaction().execute((trx) => port.plan(trx, plan))).toBe(1);
  const key = `union_auth:${accountId}:${EXPIRES}:d7:${PHONE_ID}`;

  function deliver(): Tracked {
    return track(port.deliver(appId, accountId, [{ phoneId: PHONE_ID, phone: PHONE }]));
  }

  async function row() {
    const rows = await db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    expect(rows, 'exactly one union_auth row').toHaveLength(1);
    return rows[0]!;
  }

  /** 行是 `at` 时刻的那次领取：failed ∧ sent_at 空 ∧ row_version 1，领取标识 updated_at = at。 */
  async function claimed(at: Date) {
    const current = await row();
    expect(current).toMatchObject({
      dedupe_key: key,
      status: 'failed',
      sent_at: null,
      row_version: 1,
    });
    expect(current.updated_at.getTime(), 'the claim identity is the claim instant').toBe(
      at.getTime(),
    );
    return current;
  }

  /** 行在 `at` 落定为 success（sent_at = at，row_version 2）。 */
  async function succeeded(at: Date) {
    const current = await row();
    expect(current).toMatchObject({ status: 'success', sent_at: at, row_version: 2 });
    return current;
  }

  const mark = () => lines.length;

  /** `from` 之后的日志：恰好一条 warn（本 app、本账号），没有 error 及以上。 */
  function expectOneWarn(from: number, label: string): void {
    const added = lines.slice(from).map((line) => JSON.parse(line) as Record<string, unknown>);
    const warns = added.filter((line) => line.level === 40);
    expect(warns, `${label}: exactly one warn`).toHaveLength(1);
    expect(warns[0], label).toMatchObject({ app_id: appId, union_account_id: accountId });
    expect(
      added.filter((line) => typeof line.level === 'number' && line.level > 40),
      `${label}: no error line`,
    ).toEqual([]);
  }

  function expectNoPlainPhone(): void {
    expect(lines.join('')).not.toContain(PHONE);
  }

  /** 再交付一次：不再 send / query、交付正常结束；pending() 不再列出本 app。 */
  async function expectQuiet(label: string): Promise<void> {
    const before = { sends: sms.sends.length, queries: sms.queries.length };
    const again = deliver();
    await until(
      () =>
        again.state !== 'pending' ||
        sms.sends.length > before.sends ||
        sms.queries.length > before.queries,
      `${label}: delivery ends`,
    );
    expect({ sends: sms.sends.length, queries: sms.queries.length }, label).toEqual(before);
    expect(again.state, label).toBe('resolved');
    const pending = await port.pending?.();
    expect(
      pending?.filter((p) => p.appId === appId),
      label,
    ).toEqual([]);
  }

  return {
    db,
    appId,
    accountId,
    clock,
    lines,
    sms,
    port,
    key,
    query: options.query,
    deliver,
    row,
    claimed,
    succeeded,
    mark,
    expectOneWarn,
    expectNoPlainPhone,
    expectQuiet,
  };
}
export type Harness = Awaited<ReturnType<typeof harness>>;

/** 每次 send 都是这一行、这个号码、这个模板，outId 是去重键。 */
export function expectSendsOfTheRow(h: Harness): void {
  for (const call of h.sms.sends) {
    expect(call.input).toMatchObject({
      appId: h.appId,
      phone: PHONE,
      template: 'UNION_AUTH_EXPIRING',
      outId: h.key,
    });
  }
  for (const call of h.sms.queries) {
    expect(call.input).toMatchObject({ appId: h.appId, outId: h.key, phone: PHONE });
  }
}

/**
 * A 领取并在发送中挂起 → 时钟推进超 10 分钟 → B 恢复领取（有 query 时查得 not_sent）并在发送中挂起。
 * 返回两次交付与两次领取时刻；此刻行是 B 的领取。
 */
export async function supersede(h: Harness) {
  const a = h.deliver();
  await until(() => h.sms.sends.length === 1, 'A sends');
  const claimA = h.clock.now();
  await h.claimed(claimA);
  h.clock.advanceMs(RECOVER_MS);
  const claimB = h.clock.now();
  const b = h.deliver();
  if (h.query) {
    await until(() => h.sms.queries.length === 1, 'B queries the unconfirmed claim');
    h.sms.queries[0]!.resolve('not_sent');
  }
  await until(() => h.sms.sends.length === 2, 'B sends');
  expect(a.state, 'A is still waiting for its result').toBe('pending');
  expectSendsOfTheRow(h);
  return { a, b, claimA, claimB };
}
