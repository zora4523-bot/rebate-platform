// F1-02zzp §9.3 ① ② ③：GET /v1/articles 的 summary / faq_rank / faq 筛选与 GET /v1/articles/{id} 的
// faq_rank。每条用独立 app_id；响应都过契约。
import { expect, it } from 'vitest';
import { divider, doc, image, LINK_HREF, paragraph, text } from './faq-body.ts';
import { fixture, useHarness } from './faq-harness.ts';
import {
  body,
  field,
  get,
  invalid,
  list,
  listAll,
  listUrl,
  newAppId,
  publicDetail,
  seedArticle,
} from './faq-kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

/** 第 i 秒发布（i 越大越新）。 */
function at(i: number): string {
  return `2026-10-20T01:00:${String(i).padStart(2, '0')}.000000Z`;
}
function ids(items: readonly object[]): unknown[] {
  return items.map((row) => field(row, 'article_id'));
}

it('[AC-F1-02zzp#7] 帮助、规则、公告、协议的列表项都带当前正文首段摘要；详情不带摘要', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const cases = [
    [
      'help',
      doc(image(), paragraph(), paragraph(text('帮助首段'), text('加粗', [{ type: 'bold' }]))),
      '帮助首段加粗',
    ],
    [
      'rule',
      doc(
        divider(),
        paragraph(text('  ')),
        paragraph(text('规则首段', [{ type: 'link', attrs: { href: LINK_HREF } }])),
      ),
      '规则首段',
    ],
    ['notice', doc(paragraph(text('公告首段')), paragraph(text('公告第二段'))), '公告首段'],
    ['agreement', doc(paragraph(text('协议首段')), paragraph(text('协议第二段'))), '协议首段'],
  ] as const;
  for (const [category, content, expected] of cases) {
    const id = await seedArticle(h, appId, { category, body: content });
    const page = await list(app, appId, { category });
    expect(page.items).toEqual([expect.objectContaining({ article_id: id, summary: expected })]);
    const detail = await publicDetail(app, appId, id);
    expect(detail).not.toHaveProperty('summary');
    expect(detail.body).toBe(content);
  }
});

it('[AC-F1-02zzp#8] 无文字段落或非 JSON 正文的条目没有 summary 键，同页其他条目照常带摘要', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const empty = await seedArticle(h, appId, {
    body: doc(image(), divider(), paragraph(), paragraph(text(' 　 '))),
    published_at: at(1),
  });
  const plain = await seedArticle(h, appId, { body: '纯文本旧正文', published_at: at(2) });
  const broken = await seedArticle(h, appId, {
    body: '{"type":"doc","content":[',
    published_at: at(3),
  });
  const textual = await seedArticle(h, appId, { body: body('有字的正文'), published_at: at(4) });
  const page = await list(app, appId);
  expect(ids(page.items)).toEqual([textual, broken, plain, empty]);
  expect(page.items[0]).toHaveProperty('summary', '有字的正文');
  for (const row of page.items.slice(1)) expect(row).not.toHaveProperty('summary');
  for (const category of ['rule', 'notice'] as const) {
    const legacy = await seedArticle(h, appId, { category, body: '旧数据纯文本' });
    const fresh = await seedArticle(h, appId, {
      category,
      body: body('新数据'),
      published_at: at(9),
    });
    const rows = (await list(app, appId, { category })).items;
    expect(ids(rows)).toEqual([fresh, legacy]);
    expect(rows[0]).toHaveProperty('summary', '新数据');
    expect(rows[1]).not.toHaveProperty('summary');
  }
});

it('[AC-F1-02zzp#9] 摘要取当前版本正文：草稿、未到时的定时版本与下线版本不影响；超长截到 80 码点', async () => {
  const { app, clock } = await fixture(h, 'api');
  const appId = newAppId();
  const long = `${'返'.repeat(79)}😀尾巴不进摘要`;
  const id = await seedArticle(h, appId, { body: body('第一版') });
  // v2 发布时间比 v1 早，仍应以版本号判定当前版本。
  await seedArticle(h, appId, {
    id,
    version: 2,
    body: body(long),
    published_at: '2026-10-19T00:00:00Z',
  });
  await seedArticle(h, appId, {
    id,
    version: 3,
    body: body('草稿'),
    status: 'draft',
    published_at: null,
  });
  const due = new Date(clock.now().getTime() + 60_000);
  await seedArticle(h, appId, { id, version: 4, body: body('定时版本'), published_at: due });
  await seedArticle(h, appId, { id, version: 5, body: body('下线版本'), status: 'offline' });
  expect((await list(app, appId)).items).toEqual([
    expect.objectContaining({ article_id: id, version: 2, summary: `${'返'.repeat(79)}😀` }),
  ]);
  clock.set(due);
  expect((await list(app, appId)).items).toEqual([
    expect.objectContaining({ article_id: id, version: 4, summary: '定时版本' }),
  ]);
});

it('[AC-F1-02zzp#10] 帮助当前版本有 faq_rank 时列表与详情带值，没有则无键（不为 null）；旧版本详情取旧值', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const ranked = await seedArticle(h, appId, { faq_rank: 3 });
  const unranked = await seedArticle(h, appId);
  const cleared = await seedArticle(h, appId, { faq_rank: 7 });
  await seedArticle(h, appId, { id: cleared, version: 2, faq_rank: null });
  const added = await seedArticle(h, appId);
  await seedArticle(h, appId, { id: added, version: 2, faq_rank: 999 });
  const edge = await seedArticle(h, appId, { faq_rank: 1 });
  const items = await listAll(app, appId);
  expect(items).toHaveLength(5);
  const byId = new Map(items.map((row) => [row.article_id, row]));
  expect(byId.get(ranked)).toHaveProperty('faq_rank', 3);
  expect(byId.get(added)).toHaveProperty('faq_rank', 999);
  expect(byId.get(edge)).toHaveProperty('faq_rank', 1);
  expect(byId.get(unranked)).not.toHaveProperty('faq_rank');
  expect(byId.get(cleared)).not.toHaveProperty('faq_rank');
  expect(await publicDetail(app, appId, ranked)).toHaveProperty('faq_rank', 3);
  expect(await publicDetail(app, appId, added)).toMatchObject({ version: 2, faq_rank: 999 });
  expect(await publicDetail(app, appId, added, 1)).not.toHaveProperty('faq_rank');
  expect(await publicDetail(app, appId, unranked)).not.toHaveProperty('faq_rank');
  expect(await publicDetail(app, appId, cleared)).not.toHaveProperty('faq_rank');
  expect(await publicDetail(app, appId, cleared, 1)).toHaveProperty('faq_rank', 7);
  for (const category of ['rule', 'notice', 'agreement'] as const) {
    const id = await seedArticle(h, appId, { category });
    const rows = (await list(app, appId, { category })).items;
    expect(ids(rows)).toEqual([id]);
    expect(rows[0]).not.toHaveProperty('faq_rank');
    expect(await publicDetail(app, appId, id)).not.toHaveProperty('faq_rank');
  }
});

it('[AC-F1-02zzp#11] faq=true 只留当前版本有 faq_rank 的帮助文章，顺序同不筛选、不按 faq_rank 排；faq=false 同省略', async () => {
  const { app, clock } = await fixture(h, 'api');
  const appId = newAppId();
  const otherApp = newAppId();
  // 发布先后与 faq_rank 大小故意不一致：按 faq_rank 排序会得到另一个顺序。
  const ranks = [5, null, 1, 9, null, 3];
  const plain: string[] = [];
  for (const [i, faq_rank] of ranks.entries()) {
    plain.push(await seedArticle(h, appId, { faq_rank, published_at: at(10 + i) }));
  }
  // 当前版本清空了 faq_rank：不能用旧版本的值复活。
  const cleared = await seedArticle(h, appId, { faq_rank: 2, published_at: at(1) });
  await seedArticle(h, appId, { id: cleared, version: 2, faq_rank: null, published_at: at(2) });
  // 只有草稿带 faq_rank：不算。
  const drafted = await seedArticle(h, appId, { published_at: at(3) });
  await seedArticle(h, appId, {
    id: drafted,
    version: 2,
    faq_rank: 4,
    status: 'draft',
    published_at: null,
  });
  // 定时版本带 faq_rank：到时才算。
  const due = new Date(clock.now().getTime() + 60_000);
  const scheduled = await seedArticle(h, appId, { published_at: at(4) });
  await seedArticle(h, appId, { id: scheduled, version: 2, faq_rank: 6, published_at: due });
  // 另一个 app 的同类文章不出现。
  await seedArticle(h, otherApp, { faq_rank: 8, published_at: at(30) });
  await seedArticle(h, appId, { category: 'rule', published_at: at(31) });

  const expected = [plain[5], plain[3], plain[2], plain[0]];
  const filtered = await list(app, appId, { faq: true });
  expect(ids(filtered.items)).toEqual(expected);
  expect(filtered.items.map((row) => field(row, 'faq_rank'))).toEqual([3, 9, 1, 5]);
  expect(filtered.next_cursor).toBeNull();
  const unfiltered = await list(app, appId);
  expect(ids(unfiltered.items)).toEqual([...plain].reverse().concat([scheduled, drafted, cleared]));
  const off = await get(app, appId, listUrl({ faq: false }), 'publicList');
  expect(off.response.json()).toMatchObject({ code: 0, data: unfiltered });

  clock.set(due);
  const later = await list(app, appId, { faq: true });
  expect(ids(later.items)).toEqual([scheduled, ...expected]);
  expect(later.items[0]).toMatchObject({ version: 2, faq_rank: 6 });
});

it('[AC-F1-02zzp#12] faq=true 在分页前筛选：页大小与游标同不筛选，同刻 id 连续翻页，游标不绑定筛选', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const all: string[] = [];
  const matching: string[] = [];
  // 后插入的两条不带 faq_rank：取一页再在内存里过滤会得到短页或空页。
  for (let i = 0; i < 10; i += 1) {
    const ranked = [0, 2, 4, 5, 7].includes(i);
    const id = await seedArticle(h, appId, {
      faq_rank: ranked ? matching.length + 1 : null,
      published_at: `2026-10-20T01:00:00.00000${Math.floor(i / 2) + 1}Z`,
    });
    all.push(id);
    if (ranked) matching.push(id);
  }
  const seen: string[] = [];
  const ranks: unknown[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = await list(app, appId, {
      faq: true,
      limit: 2,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.items).toHaveLength(pageIndex === 2 ? 1 : 2);
    seen.push(...page.items.map((row) => row.article_id));
    ranks.push(...page.items.map((row) => field(row, 'faq_rank')));
    if (pageIndex === 2) expect(page.next_cursor).toBeNull();
    else {
      expect(page.next_cursor).toEqual(expect.any(String));
      cursor = page.next_cursor!;
      const last = page.items.at(-1)!;
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual([
        'help',
        last.published_at,
        last.article_id,
      ]);
    }
  }
  expect(seen).toEqual([...matching].reverse());
  expect(ranks).toEqual([5, 4, 3, 2, 1]);
  // 不筛选的游标可接着带 faq=true 读，反之亦然。
  const unfiltered = await list(app, appId, { limit: 4 });
  expect(ids(unfiltered.items)).toEqual(all.slice(-4).reverse());
  const continued = await list(app, appId, {
    faq: true,
    cursor: unfiltered.next_cursor!,
    limit: 10,
  });
  expect(ids(continued.items)).toEqual(matching.slice(0, 4).reverse());
  expect(continued.next_cursor).toBeNull();
  const firstFaq = await list(app, appId, { faq: true, limit: 2 });
  expect(ids(firstFaq.items)).toEqual(matching.slice(-2).reverse());
  const rest = await list(app, appId, { cursor: firstFaq.next_cursor!, limit: 10 });
  expect(ids(rest.items)).toEqual(all.slice(0, all.indexOf(matching.at(-2)!)).reverse());
});

it('[AC-F1-02zzp#13] faq 与 help_section 叠加：两个条件同时成立才返回', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const invite = { help_section: 'invite' } as const;
  const a = await seedArticle(h, appId, { ...invite, faq_rank: 1, published_at: at(1) });
  const b = await seedArticle(h, appId, { ...invite, published_at: at(2) });
  const c = await seedArticle(h, appId, {
    help_section: 'withdraw',
    faq_rank: 2,
    published_at: at(3),
  });
  const d = await seedArticle(h, appId, { faq_rank: 3, published_at: at(4) });
  expect(ids((await list(app, appId, { ...invite, faq: true })).items)).toEqual([a]);
  expect(ids((await list(app, appId, { faq: true })).items)).toEqual([d, c, a]);
  expect(ids((await list(app, appId, { ...invite, faq: false })).items)).toEqual([b, a]);
  const withdraw = await list(app, appId, { help_section: 'withdraw', faq: true });
  expect(withdraw.items).toEqual([
    expect.objectContaining({ article_id: c, help_section: 'withdraw', faq_rank: 2 }),
  ]);
});

it.each(['rule', 'notice', 'agreement'] as const)(
  '[AC-F1-02zzp#14] %s 带 faq → 20001 fields=[faq]，先于游标校验；与 help_section 同错时 help_section 在前',
  async (category) => {
    const { app } = await fixture(h, 'api');
    const appId = newAppId();
    await seedArticle(h, appId, { category });
    for (const suffix of ['', '&cursor=broken', '&limit=5']) {
      await invalid(
        await get(app, appId, `/v1/articles?category=${category}&faq=true${suffix}`, 'publicList'),
        ['faq'],
      );
    }
    await invalid(
      await get(
        app,
        appId,
        `/v1/articles?category=${category}&help_section=invite&faq=true`,
        'publicList',
      ),
      ['help_section', 'faq'],
    );
  },
);
