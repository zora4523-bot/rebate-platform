import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RootOperationNode,
} from 'kysely';
import { expect, it } from 'vitest';
import type { InviteRelationHitInput } from '../../../../apps/api/src/modules/risk/application/invite-relation-hits.ts';
import { AT, HASH, FixedClock, createInviteRelationHitWriter } from './kit.ts';

it.each([
  '',
  'inv_08_unknown',
  'INV_08_SELF',
  'inv_08_self ',
  'SAME_DEVICE_MULTI_ACCOUNT',
  null,
  undefined,
  8,
])('[AC-B1-03x#1] 非法 rule_id %s 抛 TypeError，登记规则前也不得发 SQL', async (ruleId) => {
  const writer = createInviteRelationHitWriter({ clock: new FixedClock(AT) });
  const queries: RootOperationNode[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery(args) {
          queries.push(args.node);
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      },
    ],
  });
  try {
    await db.transaction().execute(async (trx) => {
      await expect(
        Promise.resolve().then(() =>
          writer.record(trx, {
            app_id: 'invite-validation',
            user_id: '00000000-0000-4000-8000-000000000001',
            rule_id: ruleId as InviteRelationHitInput['rule_id'],
            dimension: 'user_id',
            value_hmac: HASH,
          }),
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(queries).toEqual([]);
    });
  } finally {
    await db.destroy();
  }
});
