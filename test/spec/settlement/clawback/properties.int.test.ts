// B2-04s property entry (body: test/properties/settlement/clawback/clawback-property.ts). Runs and
// seed come from @couli/testing only (PROP_RUNS / PROP_SEED).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  assertClawbackProperty,
  clawbackRuns,
} from '../../../properties/settlement/clawback/clawback-property.ts';
import { databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it('[AC-B2-04s#40] 属性：任意 N、预留比例、受益人比例与入账前后状态，多次部分扣回的结果等于从入账一次性按新基数重算（BR-CALC-09）；每步受益人净额不为负、应收 = N_new 正数部分 − 待补记额、平台净额与 booked 成对值都与规则推出的一致，重放不再记账', async () => {
  const h = await harness(p.db);
  expect(await assertClawbackProperty(h)).toBe(clawbackRuns());
}, 900_000);
