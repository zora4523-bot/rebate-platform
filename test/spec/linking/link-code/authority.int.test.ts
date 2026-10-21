import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPddAuthLinkOpen } from '../../../../apps/api/src/modules/linking/application/link-open-pdd-auth.ts';
import { createUnionBindingsWithPddQuery } from '../../../../apps/api/src/modules/linking/application/union-bindings-pdd.ts';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { fixture as openFixture } from '../open-pdd-auth/kit.ts';
import { fixture as bindingsFixture } from '../bindings-pdd-query/kit.ts';
import { built, codeDb, databaseFixture, row, seedLink } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-08s#29] 拼多多同一次 open 的备案身份不含 lk，成功后的转链身份含该 link 的 lk', async () => {
  const db = await codeDb(database());
  const f = await built(() => openFixture(database(), { binding: 'invalid', query: true }));
  f.config.set('attr.click_code.pdd', true);
  const link = { ...(await row(db, f.row.link_id)), link_id: randomUUID(), lk: 'auth01' };
  await db.insertInto('links').values(link).execute();
  const result = await built(() =>
    createPddAuthLinkOpen(f.options).open(f.request({ linkId: link.link_id })),
  );
  expect(result.envelope.code).toBe(0);
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(JSON.stringify((f.query.mock.calls[0]![0] as JdPddIdentity).custom_parameters)).toBe(
    '{"app":"n","uid":"pdd0000a","sc":"self_buy"}',
  );
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(JSON.stringify((f.convert.mock.calls[0]![1] as JdPddIdentity).custom_parameters)).toBe(
    '{"app":"n","uid":"pdd0000a","sc":"self_buy","lk":"auth01"}',
  );
});

it('[AC-B1-08s#30] 拼多多授权页刷新有已发 lk 的链接、开关 true，也只用不含 lk 的备案身份', async () => {
  const db = await codeDb(database());
  const f = await built(() => bindingsFixture(database()));
  await seedLink(db, 'auth02', { app_id: f.appId, user_id: f.a.userId, platform: 'pdd' });
  const options = {
    ...f.options,
    config: { configValue: async () => ({ value: true, version: 1 }) },
  };
  const result = await built(() =>
    createUnionBindingsWithPddQuery(options).list({ traceId: f.traceId }),
  );
  expect(result.envelope.code).toBe(0);
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(JSON.stringify((f.query.mock.calls[0]![0] as JdPddIdentity).custom_parameters)).toBe(
    '{"app":"n","uid":"pdd0000a","sc":"self_buy"}',
  );
});
