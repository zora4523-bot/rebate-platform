import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { indexes } from './catalog.ts';
import { AT, EVIDENCE, STATUSES, claim, insert, ready, sqlState, useHarness } from './kit.ts';

const h = useHarness();

it('[AC-B1-10a#8] J-b claims creation and update times come from the application clock', async () => {
  await ready(h.app);
  const row = await claim(h.app);
  const result = await insert(h.app, 'claims', row);
  expect(result.rows[0]).toMatchObject({ created_at: AT, updated_at: AT, row_version: 0 });
  for (const name of ['created_at', 'updated_at']) {
    const missing = await claim(h.app);
    delete missing[name];
    expect(await sqlState(insert(h.app, 'claims', missing)), name).toBe('23502');
  }
});

it('[AC-B1-10a#9] J-c claims reason is nullable free text rather than a reason-code enum', async () => {
  await ready(h.app);
  for (const reason of [null, '', '客服说明：订单 123-456 已核对，并非原因码']) {
    const row = await claim(h.app, { reason });
    const result = await insert(h.app, 'claims', row);
    expect(result.rows[0]?.['reason']).toBe(reason);
  }
});

it('[AC-B1-10a#10] J-d order numbers reject only empty strings or half-width spaces and retain hyphens', async () => {
  await ready(h.app);
  for (const order_no of ['', ' ', ' 123', '123 ', '12 34']) {
    expect(await sqlState(insert(h.app, 'claims', await claim(h.app, { order_no })))).toBe('23514');
  }
  for (const platform of ['taobao', 'pdd']) {
    for (const order_no of ['123456', '123-456', '000123-00456', '12\t34', '12　34']) {
      const result = await insert(h.app, 'claims', await claim(h.app, { platform, order_no }));
      expect(result.rows[0]?.['order_no']).toBe(order_no);
    }
  }
});

it('[AC-B1-10a#11] J-e status and weakest evidence obey the complete cross-column matrix', async () => {
  await ready(h.app);
  for (const status of STATUSES) {
    for (const evidence_level of [null, ...EVIDENCE]) {
      // submitted iff NULL; terminal states permit every non-NULL evidence level.
      const allowed =
        status === 'submitted'
          ? evidence_level === null
          : status === 'auto_matched'
            ? evidence_level === 'strong'
            : status === 'manual_review'
              ? ['weak', 'none'].includes(evidence_level ?? '')
              : evidence_level !== null;
      const row = await claim(h.app, { status, evidence_level });
      expect(await sqlState(insert(h.app, 'claims', row)), `${status}/${evidence_level}`).toBe(
        allowed ? 'no error' : '23514',
      );
    }
  }
});

it('[AC-B1-10a#12] order type and enum domains reject unknown, empty and case-altered values', async () => {
  await ready(h.app);
  for (const order_no_type of ['sub', 'parent']) {
    expect(await sqlState(insert(h.app, 'claims', await claim(h.app, { order_no_type })))).toBe(
      'no error',
    );
  }
  for (const changes of [
    { order_no_type: 'child' },
    { order_no_type: '' },
    { order_no_type: 'SUB' },
    { status: 'pending', evidence_level: 'strong' },
    { status: '', evidence_level: 'strong' },
    { status: 'APPROVED', evidence_level: 'strong' },
    { status: 'approved', evidence_level: '' },
    { status: 'approved', evidence_level: 'STRONG' },
    { status: 'approved', evidence_level: 'invalid' },
  ]) {
    expect(await sqlState(insert(h.app, 'claims', await claim(h.app, changes)))).toBe('23514');
  }
});

it('[AC-B1-10a#13] J-h review queue index covers exactly auto_matched and manual_review', async () => {
  await ready(h.app);
  const index = (await indexes(h.app, 'claims')).find((i) => i.name === 'claims_review_queue_idx');
  expect(index).toMatchObject({ valid: true, ready: true, unique: false });
  expect(new Set(index?.keys)).toEqual(new Set(['app_id', 'status', 'created_at']));
  expect(index?.descending).toEqual([]);
  expect(index?.predicate).toBeTypeOf('string');
  for (const status of STATUSES) {
    const result = await sql<{ included: boolean }>`SELECT
      (${sql.raw(index?.predicate ?? 'NULL')}) IS TRUE AS included
      FROM (SELECT ${status}::text AS status, 'couli'::text AS app_id,
        ${AT}::timestamptz AS created_at) sample`.execute(h.app);
    expect(result.rows).toEqual([{ included: ['auto_matched', 'manual_review'].includes(status) }]);
  }
});

it('[AC-B1-10a#14] J-j platform uses the dictionary FK and no fixed platform CHECK', async () => {
  await ready(h.app);
  const platforms = await sql<{ code: string }>`SELECT code FROM app.platforms`.execute(h.app);
  expect(platforms.rows.length).toBeGreaterThan(0);
  for (const { code } of platforms.rows) {
    expect(await sqlState(insert(h.app, 'claims', await claim(h.app, { platform: code })))).toBe(
      'no error',
    );
  }
  expect(
    await sqlState(insert(h.app, 'claims', await claim(h.app, { platform: 'missing-platform' }))),
  ).toBe('23503');
});
