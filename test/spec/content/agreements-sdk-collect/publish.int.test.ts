// F1-02zzs §9.2#1–3 / §9.3#1–2,5: real admin route, PostgreSQL writes and refusals. sdk_list and
// collect_list publish like the other types (BR-ID-12) with min_version = version and
// requires_resign false; a refusal writes nothing.
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BODY,
  NOTICES,
  input,
  publishOk,
  publishRefused,
  rejected,
  setup,
  snapshot,
  textUrl,
  useHarness,
} from './sdk-collect-api-kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

const DIGEST = createHash('sha256').update(BODY, 'utf8').digest('hex');

it.each(NOTICES)(
  '[AC-F1-02zzs#7] %s 首发与第二版发布成功：min_version=version、不重签、agreement 类文章、H5 地址、每版一条审计',
  async (type) => {
    const f = await setup(h);
    const empty = await snapshot(h, f.appId);
    const first = await publishOk(f, type);
    const firstAt = f.clock.now();
    expect(first).toMatchObject({
      type,
      version: 1,
      min_version: 1,
      requires_resign: false,
      article_version: 1,
      text_sha256: DIGEST,
      url: textUrl(type, 1),
      legal_confirmed_by: input().legal_confirmed_by,
      legal_confirm_note: input().legal_confirm_note,
      published_by: f.actor.id,
    });
    expect(new Date(first.published_at)).toEqual(firstAt);
    const one = await snapshot(h, f.appId);
    expect(one.agreements).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        type,
        version: 1,
        min_version: 1,
        requires_resign: false,
        article_id: first.article_id,
        article_version: 1,
        text_sha256: DIGEST,
        url: textUrl(type, 1),
        published_by: f.actor.id,
      }),
    ]);
    expect(one.articles).toEqual([
      expect.objectContaining({
        id: first.article_id,
        app_id: f.appId,
        version: 1,
        category: 'agreement',
        status: 'published',
        title: input().title,
        body: BODY,
      }),
    ]);
    const firstAudits = one.audits.filter((row) => row.action === 'agreement_publish');
    expect(firstAudits).toEqual([
      expect.objectContaining({ admin_id: f.actor.id, target: `${type}:1`, before: null }),
    ]);
    expect(firstAudits[0]?.after).toMatchObject({
      type,
      version: 1,
      min_version: 1,
      requires_resign: false,
      article_id: first.article_id,
      legal_confirmed_by: input().legal_confirmed_by,
      legal_confirmed_on: input().legal_confirmed_on,
    });

    const second = await publishOk(f, type, {
      title: '第二版清单',
      min_version: 2,
      expected_version: 1,
    });
    expect(second).toMatchObject({
      type,
      version: 2,
      min_version: 2,
      requires_resign: false,
      article_id: first.article_id,
      article_version: 2,
      url: textUrl(type, 2),
    });
    const two = await snapshot(h, f.appId);
    expect(
      two.agreements.map((row) => [row.type, row.version, row.min_version, row.requires_resign]),
    ).toEqual([
      [type, 1, 1, false],
      [type, 2, 2, false],
    ]);
    expect(two.articles.map((row) => [row.id, row.version, row.category, row.title])).toEqual([
      [first.article_id, 1, 'agreement', input().title],
      [first.article_id, 2, 'agreement', '第二版清单'],
    ]);
    const audits = two.audits.filter((row) => row.action === 'agreement_publish');
    expect(audits.map((row) => row.target)).toEqual([`${type}:1`, `${type}:2`]);
    expect(audits[1]?.before).toEqual({ version: 1, min_version: 1, requires_resign: false });
    expect(audits[1]?.after).toMatchObject({ type, version: 2, min_version: 2 });
    // No legal.* key and no configuration history for a notice (§9.2#3).
    expect(two.items).toEqual(empty.items);
    expect(two.versions).toEqual(empty.versions);
  },
);

it.each(NOTICES)(
  '[AC-F1-02zzs#8] %s min_version 不等于新版本（首发 2、次版 1 或 3）→ 20001 [min_version]，不写任何行',
  async (type) => {
    const f = await setup(h);
    const empty = await snapshot(h, f.appId);
    await rejected(await publishRefused(f, type, { min_version: 2 }), 'publish', 20001, {
      fields: ['min_version'],
    });
    expect(await snapshot(h, f.appId)).toEqual(empty);
    await publishOk(f, type);
    const before = await snapshot(h, f.appId);
    for (const min of [1, 3]) {
      await rejected(
        await publishRefused(f, type, { min_version: min, expected_version: 1 }),
        'publish',
        20001,
        { fields: ['min_version'] },
      );
      expect(await snapshot(h, f.appId)).toEqual(before);
    }
    expect(await publishOk(f, type, { min_version: 2, expected_version: 1 })).toMatchObject({
      version: 2,
      min_version: 2,
    });
  },
);

it.each(NOTICES)(
  '[AC-F1-02zzs#9] %s 重签标记、法务确认与 CAS 照旧：requires_resign=true、空白确认人或说明 → 20001，版本不符 → 20902',
  async (type) => {
    const f = await setup(h);
    const empty = await snapshot(h, f.appId);
    await rejected(await publishRefused(f, type, { requires_resign: true }), 'publish', 20001, {
      fields: ['requires_resign'],
    });
    await rejected(await publishRefused(f, type, { legal_confirmed_by: '  ' }), 'publish', 20001, {
      fields: ['legal_confirmed_by'],
    });
    await rejected(await publishRefused(f, type, { legal_confirm_note: '\t' }), 'publish', 20001, {
      fields: ['legal_confirm_note'],
    });
    await rejected(await publishRefused(f, type, { expected_version: 1 }), 'publish', 20902, {
      resource: 'agreement',
    });
    expect(await snapshot(h, f.appId)).toEqual(empty);
    await publishOk(f, type);
    const before = await snapshot(h, f.appId);
    await rejected(
      await publishRefused(f, type, { min_version: 1, requires_resign: true, expected_version: 1 }),
      'publish',
      20001,
      { fields: ['min_version', 'requires_resign'] },
    );
    await rejected(
      await publishRefused(f, type, { min_version: 2, expected_version: 0 }),
      'publish',
      20902,
      { resource: 'agreement' },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02zzs#10] 同 app 内隐私、用户协议、劳务协议的发布与 legal.* 写入不受两类影响（回归抽样）', async () => {
  const f = await setup(h);
  // privacy still accepts a minimum below the new version and moves both legal keys.
  await publishOk(f, 'privacy');
  expect(await publishOk(f, 'privacy', { min_version: 1, expected_version: 1 })).toMatchObject({
    version: 2,
    min_version: 1,
    requires_resign: false,
  });
  await publishOk(f, 'labor_agreement', { requires_resign: true });
  expect(
    await publishOk(f, 'labor_agreement', { min_version: 1, expected_version: 1 }),
  ).toMatchObject({ version: 2, min_version: 1, requires_resign: false });
  await publishOk(f, 'agreement');
  const consent = await snapshot(h, f.appId);
  const legal = (state: typeof consent) =>
    state.items
      .filter((row) => row.key.startsWith('legal.'))
      .map((row) => [row.key, row.value, row.version]);
  expect(legal(consent)).toEqual([
    ['legal.agreement.min_version', 1, 1],
    ['legal.agreement.version', 1, 1],
    ['legal.privacy.min_version', 1, 2],
    ['legal.privacy.version', 2, 2],
  ]);
  for (const type of NOTICES) {
    expect(await publishOk(f, type)).toMatchObject({ type, version: 1, min_version: 1 });
  }
  const mixed = await snapshot(h, f.appId);
  expect(mixed.items).toEqual(consent.items);
  expect(mixed.versions).toEqual(consent.versions);
  // privacy keeps publishing after the notices, and its keys move as before.
  await publishOk(f, 'privacy', { min_version: 3, expected_version: 2 });
  const after = await snapshot(h, f.appId);
  expect(legal(after)).toEqual([
    ['legal.agreement.min_version', 1, 1],
    ['legal.agreement.version', 1, 1],
    ['legal.privacy.min_version', 3, 3],
    ['legal.privacy.version', 3, 3],
  ]);
  const notLegal = /^legal\.(sdk_list|collect_list|labor_agreement)\./;
  expect(after.items.filter((row) => notLegal.test(row.key))).toEqual([]);
  expect(
    after.agreements.map((row) => [row.type, row.version, row.min_version, row.requires_resign]),
  ).toEqual([
    ['agreement', 1, 1, false],
    ['collect_list', 1, 1, false],
    ['labor_agreement', 1, 1, true],
    ['labor_agreement', 2, 1, false],
    ['privacy', 1, 1, false],
    ['privacy', 2, 1, false],
    ['privacy', 3, 3, false],
    ['sdk_list', 1, 1, false],
  ]);
});
