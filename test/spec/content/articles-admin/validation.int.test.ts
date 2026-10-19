import { expect, it } from 'vitest';
import { useHarness } from './harness.ts';
import {
  body,
  config,
  conflict,
  create,
  draft,
  fields,
  newId,
  publish,
  save,
  seedArticle,
  send,
  setup,
  snapshot,
  success,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));
const HREF = 'body.content[0].content[0].marks[0].attrs.href';

it.each([
  '0199F102-AAAA-7000-8000-000000000001',
  '0199f102-aaaa-4000-8000-000000000001',
  'not-a-uuid',
])('[AC-F1-02w#12] 新建 id 必须小写规范 UUIDv7，先于 category 与保存校验：%s', async (id) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'create', id, {
      article_id: id,
      category: 'agreement',
      ...draft({ title: '全网最低' }),
    }),
    ['article_id'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#13] 新建 agreement 优先于保存校验拒绝；已有协议三个写均只读且先于 CAS', async () => {
  const f = await setup(h);
  const id = newId();
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'create', id, {
      article_id: id,
      category: 'agreement',
      ...draft({ title: '全网最低' }),
    }),
    ['category'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  await seedArticle(h, f, id, { category: 'agreement' });
  const seeded = await snapshot(h, f.appId);
  for (const [op, payload] of [
    ['save', { ...draft({ title: '全网最低' }), expected_row_version: 99 }],
    ['publish', { version: 1, expected_row_version: 99 }],
    ['offline', { expected_row_version: 99 }],
  ] as const) {
    await fields(await send(f, op, id, payload), ['category']);
    expect(await snapshot(h, f.appId)).toEqual(seeded);
  }
});

it.each(['create', 'save'] as const)(
  '[AC-F1-02w#14] %s 标题禁用词报告字段和词，不附 title 路径',
  async (op) => {
    const f = await setup(h);
    const id = newId();
    if (op === 'save') await create(f, id);
    const before = await snapshot(h, f.appId);
    const payload =
      op === 'create'
        ? { article_id: id, category: 'help', ...draft({ title: '全网最低' }) }
        : { ...draft({ title: '全网最低' }), expected_row_version: 0 };
    await fields(await send(f, op, id, payload), ['title', '全网最低']);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02w#15] 多字段错误按字段、词、body 路径顺序输出并去重', async () => {
  const f = await setup(h);
  const id = newId();
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'create', id, {
      article_id: id,
      category: 'notice',
      title: '全网最低',
      body: body('全网最低', 'https://union.example.test/item'),
      notice_closable: false,
    }),
    ['title', 'body', 'notice_end_at', '全网最低', HREF, 'body.content[0]'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#16] union_host 开关缺失按开，仅布尔 false 放行；草稿与发布读取事务内最新值', async () => {
  const f = await setup(h);
  const id = newId();
  const content = body('详情', 'https://sub.union.example.test/item');
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'create', id, { article_id: id, category: 'help', ...draft({ body: content }) }),
    ['body', HREF],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  await config(h, f, 'external_page.union_host_block', false);
  expect((await create(f, id, { body: content })).versions[0]!.body).toBe(content);
  await config(h, f, 'external_page.union_host_block', true);
  let checkpoint = await snapshot(h, f.appId);
  await fields(
    await send(f, 'save', id, { ...draft({ body: content }), expected_row_version: 0 }),
    ['body', HREF],
  );
  await fields(await send(f, 'publish', id, { version: 1, expected_row_version: 0 }), [
    'body',
    HREF,
  ]);
  expect(await snapshot(h, f.appId)).toEqual(checkpoint);
  await config(h, f, 'external_page.union_host_block', false);
  expect(await publish(f, id, 0, 1)).toMatchObject({ current_version: 1 });
  await config(h, f, 'external_page.union_host_block', 'false');
  checkpoint = await snapshot(h, f.appId);
  await fields(
    await send(f, 'save', id, { ...draft({ body: content }), expected_row_version: 1 }),
    ['body', HREF],
  );
  expect(await snapshot(h, f.appId)).toEqual(checkpoint);
});

it.each([
  {
    label: '联盟主机',
    input: { body: body('详情', 'https://union.example.test/a') },
    expected: ['body', HREF],
  },
  { label: '禁用词', input: { title: '全网最低' }, expected: ['title', '全网最低'] },
  {
    label: '不可关闭公告',
    input: { category: 'notice', notice_closable: false },
    expected: ['notice_end_at'],
  },
])('[AC-F1-02w#17] 直接 SQL 种入坏草稿，发布重校验：$label', async ({ input, expected }) => {
  const f = await setup(h);
  const id = newId();
  await seedArticle(h, f, id, input);
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'publish', id, { version: 1, expected_row_version: 0 }), expected);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([
  ['空白标题', { title: '  ' }, ['title']],
  ['非法 JSON', { body: '{' }, ['body']],
  ['HTML 正文', { body: '<p>说明</p>' }, ['body']],
  [
    '非白名单节点',
    { body: JSON.stringify({ type: 'doc', content: [{ type: 'iframe' }] }) },
    ['body', 'body.content[0].type'],
  ],
  ['HTTP 链接', { body: body('详情', 'http://safe.example.test/a') }, ['body', HREF]],
  [
    '个人数据占位',
    { body: body('详情', 'https://safe.example.test/?user_id={user_id}') },
    ['body', HREF],
  ],
  ['不可关闭无截止', { notice_closable: false }, ['notice_end_at']],
] as const)('[AC-F1-02w#18] 保存校验映射 20001：%s', async (_label, input, expected) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const id = newId();
  await fields(
    await send(f, 'create', id, { article_id: id, category: 'notice', ...draft(input) }),
    expected,
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#19] notice false 携截止可保存，其他分类忽略 notice 字段且内容版本恒 1', async () => {
  const f = await setup(h);
  const notice = await create(f, newId(), {
    category: 'notice',
    notice_closable: false,
    notice_end_at: '2026-11-01T00:00:00Z',
  });
  expect(notice.versions[0]).toMatchObject({ notice_closable: false, notice_content_version: 1 });
  const help = await create(f, newId(), { notice_closable: false });
  const next = await save(f, help.article_id, 0, { title: '修改标题', notice_closable: false });
  expect(next.versions[0]).toMatchObject({
    notice_closable: true,
    notice_end_at: null,
    notice_content_version: 1,
  });
});

it('[AC-F1-02w#20] 存稿保存校验先于 CAS，发布 CAS 先于校验', async () => {
  const f = await setup(h);
  const id = newId();
  await seedArticle(h, f, id, { title: '全网最低' });
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'save', id, { ...draft({ title: '全网最低' }), expected_row_version: 99 }),
    ['title', '全网最低'],
  );
  await conflict(await send(f, 'publish', id, { version: 1, expected_row_version: 99 }));
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#21] 媒体图只允许配置的主机，外站图片拒绝且路径加 body 前缀', async () => {
  const f = await setup(h);
  const image = (src: string) =>
    JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src } }] });
  const valid = image('https://media.example.test/assets/image.png');
  expect((await create(f, newId(), { body: valid })).versions[0]!.body).toBe(valid);
  const before = await snapshot(h, f.appId);
  const id = newId();
  await fields(
    await send(f, 'create', id, {
      article_id: id,
      category: 'help',
      ...draft({ body: image('https://other.example.test/image.png') }),
    }),
    ['body', 'body.content[0].attrs.src'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#22] help_links 豁免只随本 app 当前配置指向本文生效，变更后发布重校验', async () => {
  const f = await setup(h);
  const id = newId();
  await config(h, f, 'help_links', {
    price_compare: { route: 'Help', params: { article_id: id } },
  });
  const first = await create(f, id, { title: '比价说明', body: body('比价') });
  expect(first.versions[0]).toMatchObject({ title: '比价说明', body: body('比价') });
  const other = newId();
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'create', other, {
      article_id: other,
      category: 'help',
      ...draft({ title: '比价' }),
    }),
    ['title', '比价'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  await config(h, f, 'help_links', {
    price_compare: { route: 'Help', params: { article_id: other } },
  });
  const changed = await snapshot(h, f.appId);
  await fields(await send(f, 'publish', id, { version: 1, expected_row_version: 0 }), [
    'title',
    'body',
    '比价',
    'body.content[0]',
  ]);
  expect(await snapshot(h, f.appId)).toEqual(changed);
  await config(h, f, 'help_links', {
    price_compare: { route: 'Help', params: { article_id: id } },
  });
  expect(
    await success(await send(f, 'publish', id, { version: 1, expected_row_version: 0 })),
  ).toMatchObject({ current_version: 1 });
});
