import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { fixture as riskFixture, type Kit } from '../risk-state/service-kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
export { openKit, closeKit } from '../risk-state/service-kit.ts';
export type { Kit };

export interface Subject {
  app_id: string;
  user_id: string;
}
export type SubmitResult = { code: 0; data: Schema<'Appeal'> } | { code: 20001 };
export interface Service {
  submit(
    trx: Transaction<DB>,
    subject: Subject,
    body: Schema<'SubmitAppealRequest'>,
  ): Promise<SubmitResult>;
  list(
    subject: Subject,
    query: { limit?: number; cursor?: string },
  ): Promise<Schema<'AppealListData'>>;
}
export async function fixture(
  kit: Kit,
  state: 'banned' | 'frozen' | 'normal' | 'appealing' | 'absent' = 'banned',
) {
  const f = await riskFixture(kit);
  const riskState = f.service();
  if (state !== 'absent') {
    await f.db.transaction().execute((trx) =>
      riskState.setRiskState(trx, {
        ...f.command,
        state,
        frozen_until: state === 'frozen' ? new Date(f.clock.now().getTime() + 86400_000) : null,
      }),
    );
  }
  const beforeRows = await f.rows();
  const beforeEvents = await f.eventRows();
  f.publish.mockClear();
  const { logger, lines } = memoryLogger();
  const values = new Map<string, unknown>();
  const configValue = vi.fn(async (_app: string, key: string) =>
    values.has(key) ? { value: values.get(key), version: 1 } : null,
  );
  const setRiskState = vi.spyOn(riskState, 'setRiskState');
  const options = { db: f.db, clock: f.clock, riskState, config: { configValue }, logger };
  type Options = typeof options;
  // This call remains inside each test: the skeleton must fail the test, never a setup hook.
  async function service() {
    const { createAppealsService } = (await import(
      new URL('../../../../apps/api/src/modules/risk/application/appeals.ts', import.meta.url).href
    )) as { createAppealsService(options: Options): Service };
    return createAppealsService(options);
  }
  return {
    ...f,
    riskState,
    beforeRows,
    beforeEvents,
    options,
    service,
    setRiskState,
    values,
    configValue,
    lines,
    appeals: () =>
      f.db
        .withSchema('app')
        .selectFrom('appeals')
        .selectAll()
        .where('app_id', '=', f.subject.app_id)
        .execute(),
    submit: (
      service: Service,
      body: Schema<'SubmitAppealRequest'> = { target_type: 'account', content: '请复核' },
      subject = f.subject,
    ) => f.db.transaction().execute((trx) => service.submit(trx, subject, body)),
  };
}

export function success(result: SubmitResult) {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after success assertion');
  return result.data;
}

export function publicAppeal(value: unknown) {
  expect(Object.keys(value as object).sort()).toEqual([
    'appeal_id',
    'closed_at',
    'content',
    'created_at',
    'status',
    'target_id',
    'target_type',
  ]);
}
