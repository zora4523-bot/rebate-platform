import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { BillValidation } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  createSupplementCommand,
  type RecheckInput,
  type SupplementDependencies,
  type SupplementInput,
  type SupplementRejectReason,
} from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import { fixture as billFixture, snapshot, state as billState, MONTH } from '../bill/kit.ts';

export {
  databaseFixture,
  order,
  settlement,
  obligation,
  failItemWrite,
  BEFORE,
  MONTH,
  NOW,
  RUN,
  TIMEOUT,
} from '../bill/kit.ts';

/** 账单日任务（07-24 00:10）之后、发起补充之前：联盟结算数据后到的取得时刻。 */
export const LATER = '2032-07-25T09:00:00+08:00';
/** finance 发起补充批次的时刻（默认同时是名义请求时刻与 Clock）。 */
export const LAUNCH = '2032-07-26T10:00:00+08:00';
const SUPPLEMENT_EVENT = 'test.supplement.validation';

export function fixture(db: Kysely<DB>) {
  const h = billFixture(db);
  // 测试专用事务见证（同账单日任务 kit 的做法）：并非声明生产事件名。
  const supplementSaveValidations = vi.fn<SupplementDependencies['saveValidations']>(
    async (trx, input, rows) => {
      for (const row of rows) {
        await trx
          .withSchema('app')
          .insertInto('event_log')
          .values({
            app_id: input.appId,
            event_id: randomUUID(),
            name: SUPPLEMENT_EVENT,
            payload: JSON.stringify({
              billId: input.billId,
              platform: input.platform,
              runAt: input.runAt.toISOString(),
              ...row,
            }),
            occurred_at: h.clock.now(),
            created_at: h.clock.now(),
          })
          .execute();
      }
    },
  );
  const supplementDeps: SupplementDependencies = {
    clock: h.clock,
    config: h.deps.config,
    readSource: h.readSource,
    readSnapshot: h.readSnapshot,
    readTljDeductFen: h.readTljDeductFen,
    registerDiff: h.registerDiff,
    saveValidations: supplementSaveValidations,
  };
  // 在所有拒绝 / 回滚断言之前构造，避免 NotImplemented 被拒绝断言吞掉而误绿。
  const command = createSupplementCommand(supplementDeps);
  return {
    ...h,
    supplementDeps,
    supplementSaveValidations,
    command,
    launch: (patch: Partial<SupplementInput> = {}, target: Kysely<DB> = db) =>
      command.launch(target, {
        appId: h.appId,
        billId: MONTH,
        platform: 'taobao',
        requestedAt: new Date(LAUNCH),
        ...patch,
      }),
    recheck: (patch: Partial<RecheckInput> = {}, target: Kysely<DB> = db) =>
      command.recheckCurrentBill(target, {
        appId: h.appId,
        platform: 'taobao',
        requestedAt: new Date(LAUNCH),
        ...patch,
      }),
  };
}
export type Fixture = ReturnType<typeof fixture>;

/** 账单日任务生成 2032-06 账单（真实 B2-04n 实现），随后把时钟拨到发起时刻并清空端口调用记录。 */
export async function main(h: Fixture, platforms: readonly string[] = ['taobao']) {
  await snapshot(h);
  for (const platform of platforms) expect((await h.run(platform)).outcome).toBe('generated');
  h.clock.set(LAUNCH);
  h.readSource.mockClear();
  h.readSnapshot.mockClear();
  h.readTljDeductFen.mockClear();
  h.registerDiff.mockClear();
}

export async function state(h: Fixture) {
  return {
    ...(await billState(h)),
    supplementValidations: await h.db
      .withSchema('app')
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('name', '=', SUPPLEMENT_EVENT)
      .orderBy('event_id')
      .execute(),
  };
}
export type State = Awaited<ReturnType<typeof state>>;

export interface SavedValidation extends BillValidation {
  readonly billId: string;
  readonly platform: string;
  readonly runAt: string;
}

export async function validations(h: Fixture): Promise<SavedValidation[]> {
  return (await state(h)).supplementValidations.map((r) => r.payload as unknown as SavedValidation);
}

export function supplements(s: State) {
  return s.batches.filter((b) => b.kind === 'supplement');
}

export function mains(s: State) {
  return s.batches.filter((b) => b.kind === 'main');
}

export function itemsOf(s: State, batches: readonly { readonly batch_id: string }[]) {
  const ids = new Set(batches.map((b) => b.batch_id));
  return s.items.filter((i) => ids.has(i.batch_id));
}

/** 拒绝必须是 SupplementRejected 且不留任何写入；回调包在 Promise 中，同步抛错也由断言捕获。 */
export async function rejectedUnchanged(
  h: Fixture,
  run: () => Promise<unknown>,
  reason: SupplementRejectReason,
) {
  const before = await state(h);
  await expect(Promise.resolve().then(run)).rejects.toMatchObject({
    name: 'SupplementRejected',
    reason,
  });
  expect(await state(h)).toEqual(before);
}

export async function bill(h: Fixture, billId: string, generated: boolean) {
  await h.db
    .withSchema('app')
    .insertInto('settle_bills')
    .values({
      app_id: h.appId,
      bill_id: billId,
      generation_started_at: new Date(LATER),
      generated_at: generated ? new Date(LATER) : null,
    })
    .execute();
}
