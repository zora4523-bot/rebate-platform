import { expect, it } from 'vitest';
import { agreementVersionRow } from '../../../../apps/api/src/modules/content/infra/kysely-agreement-version-store.ts';
import { newAppId, seedAgreement, storedAgreement, useHarness } from './kit.ts';

const h = useHarness('store', () => import('@couli/db/testing'));

it('[AC-F1-02ze#11] 版本仓储每次只做一条 SELECT，返回精确八字段或 null', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'labor_agreement', 2, {
    publishedAt: '2031-03-01T00:00:00.123456Z',
  });
  await seedAgreement(h.db, appId, 'labor_agreement', 1, {
    publishedAt: '2031-03-03T00:00:00.654321Z',
  });
  await seedAgreement(h.db, newAppId(), 'labor_agreement', 9);
  const kinds: string[] = [];
  const db = h.db.withPlugin({
    transformQuery({ node }) {
      kinds.push(node.kind);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  for (const version of [null, 1, 1, 3, 3, null]) {
    kinds.length = 0;
    const row = await agreementVersionRow(db, appId, 'labor_agreement', version);
    expect(kinds).toEqual(['SelectQueryNode']);
    expect(row).toEqual(
      version === 3 ? null : await storedAgreement(h.db, appId, 'labor_agreement', version ?? 2),
    );
  }
  kinds.length = 0;
  expect(await agreementVersionRow(db, appId, 'privacy', null)).toBeNull();
  expect(kinds).toEqual(['SelectQueryNode']);
});
