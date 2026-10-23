// B2-04m property entry (body: test/properties/settlement/credit/credit-property.ts). Runs and seed
// come from @couli/testing only.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  assertCreditProperty,
  creditRuns,
} from '../../../properties/settlement/credit/credit-property.ts';
import { databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it('[AC-B2-04m#37] 属性：任意 N、预留比例、受益人比例与锁后状态，入账金额、凭证键、应收 = N − 暂缓、义务数与重放只入一次都与规则推出的结果一致', async () => {
  const h = await harness(p.db);
  expect(await assertCreditProperty(h)).toBe(creditRuns());
}, 900_000);
