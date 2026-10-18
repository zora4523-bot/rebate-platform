import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { indexes } from './catalog.ts';
import {
  AT,
  DECISIONS,
  EVIDENCE,
  LATER,
  REASONS,
  admin,
  decided,
  insert,
  item,
  ready,
  sqlState,
  update,
  useHarness,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-10a#15] J-f evidence/link arrays reject NULL loopholes and retain bigint precision', async () => {
  await ready(h.app);
  const row = await item(h.app);
  const arrays = [
    null,
    [],
    ['9007199254740993'],
    ['9007199254740993', '9223372036854775807'],
    [null],
    ['9007199254740993', null],
  ];
  for (const evidence of [null, ...EVIDENCE]) {
    for (const links of arrays) {
      const allowed =
        evidence === null
          ? links === null
          : links !== null &&
            !links.includes(null) &&
            (evidence === 'none' ? links.length === 0 : links.length > 0);
      const next = { ...row, id: randomUUID(), evidence, evidence_link_log_ids: links };
      // A transaction rolls back each successful probe so the unique key does not mask CHECKs.
      const outcome = await probe(next);
      expect(outcome, `${evidence}/${JSON.stringify(links)}`).toBe(allowed ? 'no error' : '23514');
    }
  }
  const stored = await insert(h.app, 'claim_items', {
    ...row,
    evidence: 'strong',
    evidence_link_log_ids: ['9007199254740993', '9223372036854775807'],
  });
  expect((stored.rows[0]?.['evidence_link_log_ids'] as unknown[]).map(String)).toEqual([
    '9007199254740993',
    '9223372036854775807',
  ]);
});

// The sentinel is caught by identity, leaving SQL errors available to sqlState.
async function probe(row: Record<string, unknown>) {
  const rollback = new Error('rollback successful probe');
  return sqlState(
    h.app
      .transaction()
      .execute(async (trx) => {
        await insert(trx, 'claim_items', row);
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      }),
  );
}

it('[AC-B1-10a#16] rejected iff reason present, including pending NULL and all eight reason codes', async () => {
  await ready(h.app);
  const row = await item(h.app);
  for (const decision of [null, ...DECISIONS]) {
    for (const reject_reason of [null, ...REASONS]) {
      const allowed = decision === 'rejected' ? reject_reason !== null : reject_reason === null;
      expect(
        await probe({ ...row, ...decided(decision), reject_reason }),
        `${decision}/${reject_reason}`,
      ).toBe(allowed ? 'no error' : '23514');
    }
  }
  for (const reject_reason of ['', 'other', 'UNKNOWN']) {
    expect(await probe({ ...row, ...decided('rejected'), reject_reason })).toBe('23514');
  }
});

it('[AC-B1-10a#17] decision and decided_at are paired; pending rows cannot have a deciding admin', async () => {
  await ready(h.app);
  const row = await item(h.app);
  const actor = await admin(h.app);
  for (const decision of [null, ...DECISIONS]) {
    for (const decided_at of [null, LATER]) {
      for (const decided_by of [null, actor]) {
        const allowed =
          decision === null ? decided_at === null && decided_by === null : decided_at !== null;
        expect(
          await probe({ ...row, ...decided(decision), decided_at, decided_by }),
          `${decision}/${decided_at}/${decided_by}`,
        ).toBe(allowed ? 'no error' : '23514');
      }
    }
  }
  for (const decision of ['pending', '', 'APPROVED', 'unknown']) {
    expect(await probe({ ...row, ...decided(decision) })).toBe('23514');
  }
  for (const evidence of ['', 'STRONG', 'unknown']) {
    expect(await probe({ ...row, evidence, evidence_link_log_ids: ['1'] })).toBe('23514');
  }
});

it('[AC-B1-10a#18] J-g system decisions need no admin and the DB does not impose service-only actor rules', async () => {
  await ready(h.app);
  const row = await item(h.app);
  const actor = await admin(h.app);
  for (const decided_by of [null, actor]) {
    for (const reject_reason of REASONS) {
      expect(await probe({ ...row, ...decided('rejected'), reject_reason, decided_by })).toBe(
        'no error',
      );
    }
    expect(await probe({ ...row, ...decided('cancelled'), decided_by })).toBe('no error');
  }
  await insert(h.app, 'claim_items', { ...row, ...decided('approved') });
  // Transition policy belongs to the service. No database trigger owns decision or row_version.
  const changed = await update(h.app, 'claim_items', row['id'], {
    ...decided('rejected'),
    updated_at: LATER,
  });
  expect(changed.rows[0]).toMatchObject({
    decision: 'rejected',
    row_version: 0,
    updated_at: LATER,
  });
  expect(
    (await update(h.app, 'claim_items', row['id'], { row_version: 7 })).rows[0]?.['row_version'],
  ).toBe(7);
});

it('[AC-B1-10a#19] pending index has exactly the task keys and NULL decision predicate', async () => {
  await ready(h.app);
  const index = (await indexes(h.app, 'claim_items')).find(
    (i) => i.name === 'claim_items_pending_idx',
  );
  expect(index).toMatchObject({ valid: true, ready: true, unique: false });
  expect(new Set(index?.keys)).toEqual(new Set(['app_id', 'platform', 'sub_order_id']));
  expect(index?.descending).toEqual([]);
  expect(index?.predicate).toBeTypeOf('string');
  for (const decision of [null, ...DECISIONS]) {
    const result = await sql<{ included: boolean }>`SELECT
      (${sql.raw(index?.predicate ?? 'NULL')}) IS TRUE AS included FROM
      (SELECT ${decision}::text AS decision, 'couli'::text AS app_id,
        'taobao'::text AS platform, 'synthetic'::text AS sub_order_id) sample`.execute(h.app);
    expect(result.rows).toEqual([{ included: decision === null }]);
  }
});

it('[AC-B1-10a#20] item insertion time defaults in the DB while update time stays application supplied', async () => {
  await ready(h.app);
  const row = await item(h.app);
  const result = await insert(h.app, 'claim_items', row);
  expect(result.rows[0]).toMatchObject({ row_version: 0, updated_at: AT });
  expect(result.rows[0]?.['created_at']).toBeInstanceOf(Date);
  const missing = await item(h.app);
  delete missing['updated_at'];
  expect(await sqlState(insert(h.app, 'claim_items', missing))).toBe('23502');
});
