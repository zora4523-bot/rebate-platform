// B2-04lb property entry (body: test/properties/settlement/rights-credit/precredit-credit-property.ts).
// Runs and seed come from @couli/testing only.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  assertPrecreditRightsCreditProperty,
  rightsCreditRuns,
} from '../../../properties/settlement/rights-credit/precredit-credit-property.ts';
import { databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it('[AC-B2-04lb#14] 属性：任意结算佣金 N、入账前部分维权应扣 d（N − d ≥ 10）、预留比例（≤ 9000bp）与受益人比例，入账金额、受益人余额、应收与 booked 都按 N − d 推出，不按 N', async () => {
  const h = await harness(p.db);
  expect(await assertPrecreditRightsCreditProperty(h)).toBe(rightsCreditRuns());
}, 900_000);
