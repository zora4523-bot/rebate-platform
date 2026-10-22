import { createTestDatabase } from '@couli/db/testing';
import { PostgresQueryCompiler } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createClaimResultMessageHandler } from '../../../../apps/api/src/modules/notification/application/claim-result-message.ts';
import { orders } from '../trade-read-ports/kit.ts';
import { fixture, openSuite, type Suite } from './db-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it('[AC-B1-12r#24] 审核在读取期间提交，找回单与条目必须来自同一快照，不能拼出 approved/rejected 混合结果', async () => {
  const f = await fixture(suite);
  const { item } = await f.item(321n);
  const original = orders.readNotifyClaimFacts;
  const facts: Array<Awaited<ReturnType<typeof original>>> = [];
  const spy = vi.spyOn(orders, 'readNotifyClaimFacts').mockImplementation(async (db, input) => {
    const result = await original(db, input);
    facts.push(result);
    return result;
  });
  let interleaved = false;
  const reads = new Set<unknown>();
  const observed = f.db.withPlugin({
    transformQuery(args) {
      const query = new PostgresQueryCompiler().compileQuery(args.node, args.queryId).sql;
      if (/\bselect\b/i.test(query) && /"(?:claims|claim_items)"/.test(query)) {
        reads.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (reads.delete(args.queryId) && !interleaved) {
        interleaved = true;
        // Another connection atomically changes both rows after the first SELECT returned.
        // A joined SELECT or a repeatable-read snapshot both retain the complete old view.
        await f.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('claims')
            .set({ status: 'rejected' })
            .where('app_id', '=', f.appId)
            .where('id', '=', f.claim.id)
            .execute();
          await trx
            .updateTable('claim_items')
            .set({ decision: 'rejected', reject_reason: 'NO_EVIDENCE' })
            .where('app_id', '=', f.appId)
            .where('id', '=', item.id)
            .execute();
        });
      }
      return args.result;
    },
  });
  try {
    const handler = createClaimResultMessageHandler({ clock: f.clock });
    await observed.transaction().execute((trx) => handler(f.event(), trx));
    expect(interleaved).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact?.items).toHaveLength(1);
      expect([
        { status: 'approved', decision: 'approved', reason: null },
        { status: 'rejected', decision: 'rejected', reason: 'NO_EVIDENCE' },
      ]).toContainEqual({
        status: fact?.status,
        decision: fact?.items[0]?.decision,
        reason: fact?.items[0]?.reject_reason,
      });
    }
  } finally {
    spy.mockRestore();
  }
});
