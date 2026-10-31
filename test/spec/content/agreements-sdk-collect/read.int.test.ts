// F1-02zzs §9.2#4 / §9.3#4: public reads of one type and version (30701 while unpublished),
// admin detail and list filtering, all against versions published through the admin route.
import { expect, it } from 'vitest';
import {
  BODY,
  NOTICES,
  detail,
  input,
  list,
  publicApp,
  publicList,
  publicPart,
  publicRead,
  publishOk,
  rejected,
  setup,
  storedPublic,
  success,
  useHarness,
  type AgreementsData,
  type Detail,
  type Page,
  type PublicVersion,
} from './sdk-collect-api-kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

it.each(NOTICES)(
  '[AC-F1-02zzs#11] %s 未发布 30701；发布后当前版与 ?version= 历史版按存储行返回，不存在版本 30701，另一类仍 30701',
  async (type) => {
    const f = await setup(h);
    const p = await publicApp(h);
    const other = NOTICES.find((candidate) => candidate !== type)!;
    await rejected(await publicRead(p, f.appId, type), 'version', 30701, {});
    await rejected(await publicRead(p, f.appId, type, 1), 'version', 30701, {});
    await rejected(await detail(f, type, 1), 'detail', 30701);

    const first = await publishOk(f, type);
    const second = await publishOk(f, type, { min_version: 2, expected_version: 1 });
    const current = await success<PublicVersion>(await publicRead(p, f.appId, type), 'version');
    expect(current).toEqual(await storedPublic(h, f.appId, type, 2));
    expect(current).toMatchObject(publicPart(second));
    expect(current.min_version).toBe(current.version);
    const old = await success<PublicVersion>(await publicRead(p, f.appId, type, 1), 'version');
    expect(old).toEqual(await storedPublic(h, f.appId, type, 1));
    expect(old).toMatchObject(publicPart(first));
    await rejected(await publicRead(p, f.appId, type, 3), 'version', 30701, {});
    await rejected(await publicRead(p, f.appId, other), 'version', 30701, {});

    // The list of consent agreements never carries a notice.
    const listed = await success<AgreementsData>(await publicList(p, f.appId), 'agreements');
    expect(listed).toEqual({ privacy: null, agreement: null });

    const shown = await success<Detail>(await detail(f, type, 1), 'detail');
    expect(shown).toMatchObject({
      ...publicPart(first),
      requires_resign: false,
      title: input().title,
      body: BODY,
      published_by: f.actor.id,
    });
    expect(await success<Detail>(await detail(f, type, 2), 'detail')).toMatchObject({
      version: 2,
      min_version: 2,
    });
    await rejected(await detail(f, type, 3), 'detail', 30701);
    await rejected(await detail(f, other, 1), 'detail', 30701);
  },
);

it('[AC-F1-02zzs#12] 后台列表 ?type= 精确过滤两类、无 type 含全部五类', async () => {
  const f = await setup(h);
  for (const type of NOTICES) {
    expect((await success<Page>(await list(f, `?type=${type}`), 'list')).total).toBe(0);
  }
  await publishOk(f, 'privacy');
  await publishOk(f, 'agreement');
  await publishOk(f, 'labor_agreement', { requires_resign: true });
  await publishOk(f, 'sdk_list');
  await publishOk(f, 'collect_list');
  await publishOk(f, 'sdk_list', { min_version: 2, expected_version: 1 });

  const all = await success<Page>(await list(f, '?page_size=100'), 'list');
  expect(all.total).toBe(6);
  expect(all.items.map((item) => `${item.type}:${item.version}`).sort()).toEqual([
    'agreement:1',
    'collect_list:1',
    'labor_agreement:1',
    'privacy:1',
    'sdk_list:1',
    'sdk_list:2',
  ]);

  const collect = await success<Page>(await list(f, '?type=collect_list'), 'list');
  expect(collect).toMatchObject({ total: 1, page: 1 });
  expect(collect.items).toEqual([
    expect.objectContaining({ type: 'collect_list', version: 1, min_version: 1 }),
  ]);
  const sdk = await success<Page>(await list(f, '?type=sdk_list'), 'list');
  expect(sdk.total).toBe(2);
  expect(sdk.items.map((item) => [item.type, item.version, item.min_version])).toEqual([
    ['sdk_list', 2, 2],
    ['sdk_list', 1, 1],
  ]);
  const privacy = await success<Page>(await list(f, '?type=privacy'), 'list');
  expect(privacy.items.map((item) => item.type)).toEqual(['privacy']);
});
