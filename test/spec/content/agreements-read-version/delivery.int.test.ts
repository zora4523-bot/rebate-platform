import { expect, it } from 'vitest';
import { createAgreementReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  agreementQueries,
  headers,
  missing,
  newAppId,
  read,
  seedAgreement,
  storedAgreement,
  success,
  useHarness,
  validate,
  type AgreementData,
} from './kit.ts';

const h = useHarness('delivery', () => import('@couli/db/testing'));

for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
  for (const version of [undefined, 1] as const) {
    it(`[AC-F1-02ze#1] ${type} version=${version ?? 'current'} 精确读取八字段，按版本号而非时间排序`, async () => {
      const appId = newAppId();
      // Higher version is inserted first and has an earlier publication timestamp.
      await seedAgreement(h.db, appId, type, 2, {
        minVersion: 2,
        articleVersion: 17,
        publishedAt: '2031-03-01T01:02:03.123456Z',
      });
      await seedAgreement(h.db, appId, type, 1, {
        articleVersion: 11,
        publishedAt: '2031-03-03T01:02:03.654321Z',
      });
      await seedAgreement(h.db, newAppId(), type, 9);
      const expected = await storedAgreement(h.db, appId, type, version ?? 2);
      const data = await success(await read(h.app, appId, type, version));
      expect(data).toEqual(expected);
      if (type !== 'labor_agreement' && version === undefined) {
        const list = await h.app.inject({
          method: 'GET',
          url: '/v1/agreements',
          headers: headers(appId),
        });
        expect(list.statusCode).toBe(200);
        expect(list.json<{ data: AgreementData }>().data[type]?.published_at).toBe(
          data.published_at,
        );
      }
    });
  }
}

for (const scenario of [
  'missing-version',
  'unpublished-type',
  'other-app-type',
  'other-app-version',
] as const) {
  it(`[AC-F1-02ze#2] ${scenario} 返回 HTTP 404 / 30701 和空 data`, async () => {
    const appId = newAppId();
    await seedAgreement(h.db, appId, 'privacy', 1);
    if (scenario === 'missing-version' || scenario === 'other-app-version') {
      await seedAgreement(h.db, appId, 'labor_agreement', 1);
    }
    if (scenario === 'other-app-type' || scenario === 'other-app-version') {
      await seedAgreement(h.db, newAppId(), 'labor_agreement', 3);
    }
    const version =
      scenario === 'missing-version' || scenario === 'other-app-version' ? 3 : undefined;
    h.queries.length = 0;
    await missing(await read(h.app, appId, 'labor_agreement', version));
    expect(agreementQueries(h.queries)).toHaveLength(1);
  });
}

for (const [type, version, field] of [
  ['foo', undefined, 'type'],
  ['privacy', '0', 'version'],
  ['privacy', '-1', 'version'],
  ['privacy', 'abc', 'version'],
  ['privacy', '2147483648', 'version'],
  ['privacy', '1.5', 'version'],
] as const) {
  it(`[AC-F1-02ze#3] 非法参数 ${type}/${version ?? ''} 返回 20001、fields=[${field}]，不查询协议表`, async () => {
    const appId = newAppId();
    h.queries.length = 0;
    const response = await read(h.app, appId, type, version);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: [field] } });
    await validate(response);
    expect(agreementQueries(h.queries)).toEqual([]);
  });
}

it('[AC-F1-02ze#4] int32 最大合法版本按不存在处理，不误报校验错误', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'privacy', 1);
  h.queries.length = 0;
  await missing(await read(h.app, appId, 'privacy', 2147483647));
  expect(agreementQueries(h.queries)).toHaveLength(1);
});

for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
  it(`[AC-F1-02ze#5] ${type} 当前与历史版本匿名、deletion_only、无效令牌得到相同内容`, async () => {
    const appId = newAppId();
    await seedAgreement(h.db, appId, type, 1);
    await seedAgreement(h.db, appId, type, 2);
    const restricted = await h.restrictedHeaders(appId);
    for (const version of [undefined, 1] as const) {
      // The public request intentionally has neither Authorization nor X-Device-Id.
      const anonymous = await success(await read(h.app, appId, type, version));
      const deletionOnly = await success(
        await read(h.app, appId, type, version, {
          authorization: restricted.authorization,
        }),
      );
      const invalidToken = await success(
        await read(h.app, appId, type, version, {
          authorization: 'Bearer invalid-test-token',
        }),
      );
      expect(deletionOnly).toEqual(anonymous);
      expect(invalidToken).toEqual(anonymous);
    }
  });
}

it('[AC-F1-02ze#6] 不推进时钟发布新版本即见，每次请求含重复历史读取恰好查询一次', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'labor_agreement', 1);
  const now = h.clock.now();
  h.queries.length = 0;
  expect(await success(await read(h.app, appId, 'labor_agreement'))).toMatchObject({ version: 1 });
  expect(agreementQueries(h.queries)).toHaveLength(1);
  await seedAgreement(h.db, appId, 'labor_agreement', 2, { minVersion: 2 });
  for (const version of [undefined, undefined, 1, 1, 3, 3]) {
    h.queries.length = 0;
    const response = await read(h.app, appId, 'labor_agreement', version);
    if (version === 3) await missing(response);
    else
      expect(await success(response)).toEqual(
        await storedAgreement(h.db, appId, 'labor_agreement', version ?? 2),
      );
    const queries = agreementQueries(h.queries);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.kind).toBe('SelectQueryNode');
  }
  expect(h.clock.now()).toEqual(now);
});

it('[AC-F1-02ze#7] 未发布类型的空结果不缓存，首次发布同一时钟即可读取', async () => {
  const appId = newAppId();
  const now = h.clock.now();
  await missing(await read(h.app, appId, 'agreement'));
  await seedAgreement(h.db, appId, 'agreement', 1);
  expect(await success(await read(h.app, appId, 'agreement'))).toEqual(
    await storedAgreement(h.db, appId, 'agreement', 1),
  );
  expect(h.clock.now()).toEqual(now);
});

it('[AC-F1-02ze#8] 相同类型版本跨 app 交替请求始终隔离', async () => {
  const a = newAppId();
  const b = newAppId();
  await seedAgreement(h.db, a, 'privacy', 1);
  await seedAgreement(h.db, b, 'privacy', 1);
  for (const appId of [a, b, a]) {
    expect(await success(await read(h.app, appId, 'privacy', 1))).toEqual(
      await storedAgreement(h.db, appId, 'privacy', 1),
    );
  }
});

it('[AC-F1-02ze#9] 公共读不改协议、不写同意记录或审计，含不存在与非法请求', async () => {
  const appId = newAppId();
  for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
    await seedAgreement(h.db, appId, type, 1);
    await seedAgreement(h.db, appId, type, 2);
  }
  const snapshot = async () =>
    Promise.all(
      (['agreements', 'consent_records', 'audit_logs'] as const).map((table) =>
        h.db
          .withSchema('app')
          .selectFrom(table)
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
      ),
    );
  const before = await snapshot();
  h.queries.length = 0;
  for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
    expect(await success(await read(h.app, appId, type))).toEqual(
      await storedAgreement(h.db, appId, type, 2),
    );
    expect(await success(await read(h.app, appId, type, 1))).toEqual(
      await storedAgreement(h.db, appId, type, 1),
    );
    await missing(await read(h.app, appId, type, 3));
  }
  expect((await read(h.app, appId, 'foo')).json().code).toBe(20001);
  expect(await snapshot()).toEqual(before);
  expect(
    h.queries.filter((node) => /^(Insert|Update|Delete|Merge)QueryNode$/.test(node.kind)),
  ).toEqual([]);
});

it('[AC-F1-02ze#10] 新读口不改变列表的两类形状与缓存，也不改变 identity 端口单次查询', async () => {
  const appId = newAppId();
  for (const type of ['privacy', 'agreement', 'labor_agreement'] as const) {
    await seedAgreement(h.db, appId, type, 1);
  }
  const list = () =>
    h.app.inject({ method: 'GET', url: '/v1/agreements', headers: headers(appId) });
  const before = await list();
  expect(before.statusCode).toBe(200);
  const listed = before.json<{ data: AgreementData }>().data;
  expect(listed).toEqual({
    privacy: await storedAgreement(h.db, appId, 'privacy', 1),
    agreement: await storedAgreement(h.db, appId, 'agreement', 1),
  });
  await seedAgreement(h.db, appId, 'privacy', 2);
  expect((await success(await read(h.app, appId, 'privacy'))).version).toBe(2);
  expect((await success(await read(h.app, appId, 'labor_agreement'))).version).toBe(1);
  expect((await list()).json<{ data: AgreementData }>().data).toEqual(listed);
  let queries = 0;
  const reader = createAgreementReader({
    db: h.db.withPlugin({
      transformQuery({ node }) {
        queries += 1;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    }),
  });
  expect(await reader.currentAgreement(appId, 'privacy')).toMatchObject({ version: 2 });
  expect(queries).toBe(1);
});
