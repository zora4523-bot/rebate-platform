import { expect, it } from 'vitest';
import { createAgreementReader } from '../../../../apps/api/src/modules/content/index.ts';
import { newAppId, seedAgreement, useHarness } from './kit.ts';

const h = useHarness('reader', () => import('@couli/db/testing'));

for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
  it(`[AC-F1-02n#1] ${type} 按最大 version 取当前行，精确返回六字段`, async () => {
    const appId = newAppId();
    await seedAgreement(h.db, appId, type, 1, { publishedAt: '2031-03-03T00:00:00.000Z' });
    const current = await seedAgreement(h.db, appId, type, 2, {
      minVersion: 2,
      publishedAt: '2031-03-01T00:00:00.123Z',
    });
    await seedAgreement(h.db, newAppId(), type, 9);
    const reader = createAgreementReader({ db: h.db });
    expect(await reader.currentAgreement(appId, type)).toEqual({
      version: 2,
      min_version: 2,
      resign_from_version: 2,
      text_url: current.url,
      text_sha256: current.text_sha256,
      published_at: new Date(current.published_at),
    });
  });
}

it('[AC-F1-02n#2] 无劳务协议、只有其他 app、只有其他 type 时均为 null', async () => {
  const appId = newAppId();
  const reader = createAgreementReader({ db: h.db });
  expect(await reader.currentAgreement(appId, 'labor_agreement')).toBeNull();
  await seedAgreement(h.db, newAppId(), 'labor_agreement', 1);
  expect(await reader.currentAgreement(appId, 'labor_agreement')).toBeNull();
  await seedAgreement(h.db, appId, 'privacy', 1);
  expect(await reader.currentAgreement(appId, 'agreement')).toBeNull();
});

it('[AC-F1-02n#3] 同一个端口不推进时钟就能读到刚发布的 v3，重签门槛取 min_version', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'labor_agreement', 2, { minVersion: 2 });
  const reader = createAgreementReader({ db: h.db });
  expect(await reader.currentAgreement(appId, 'labor_agreement')).toMatchObject({ version: 2 });
  const now = h.clock.now();
  const latest = await seedAgreement(h.db, appId, 'labor_agreement', 3, { minVersion: 2 });
  expect(await reader.currentAgreement(appId, 'labor_agreement')).toEqual({
    version: 3,
    min_version: 2,
    resign_from_version: 2,
    text_url: latest.url,
    text_sha256: latest.text_sha256,
    published_at: new Date(latest.published_at),
  });
  expect(h.clock.now()).toEqual(now);
});

it('[AC-F1-02n#4] 空结果不缓存，首次发布立即可读', async () => {
  const appId = newAppId();
  const reader = createAgreementReader({ db: h.db });
  expect(await reader.currentAgreement(appId, 'agreement')).toBeNull();
  await seedAgreement(h.db, appId, 'agreement', 1);
  expect(await reader.currentAgreement(appId, 'agreement')).toMatchObject({ version: 1 });
});

it('[AC-F1-02n#5] 接受调用方事务句柄，能读取同事务未提交的新版本', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'privacy', 1);
  const outside = createAgreementReader({ db: h.db });
  await h.db.transaction().execute(async (trx) => {
    const row = await seedAgreement(trx, appId, 'privacy', 2, { minVersion: 2 });
    expect(await outside.currentAgreement(appId, 'privacy')).toMatchObject({ version: 1 });
    const inside = createAgreementReader({ db: trx });
    expect(await inside.currentAgreement(appId, 'privacy')).toEqual({
      version: 2,
      min_version: 2,
      resign_from_version: 2,
      text_url: row.url,
      text_sha256: row.text_sha256,
      published_at: new Date(row.published_at),
    });
  });
  expect(await outside.currentAgreement(appId, 'privacy')).toMatchObject({ version: 2 });
});

it('[AC-F1-02n#19] 每次端口读取恰好执行一条查询，包括重复读取与空结果', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'privacy', 1);
  let queries = 0;
  const observedDb = h.db.withPlugin({
    transformQuery({ node }) {
      queries += 1;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const reader = createAgreementReader({ db: observedDb });
  expect(queries).toBe(0);
  for (const type of ['privacy', 'privacy', 'labor_agreement'] as const) {
    const before = queries;
    const result = await reader.currentAgreement(appId, type);
    expect(queries - before).toBe(1);
    if (type === 'privacy') expect(result).toMatchObject({ version: 1 });
    else expect(result).toBeNull();
  }
});
