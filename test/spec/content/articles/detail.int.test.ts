// F1-02f rulings 4, 5, 11: GET /v1/articles/{article_id} accepts only lowercase canonical UUIDs
// (anything else is 404 / 30701 without reaching PG, never 500), is scoped to the request's app,
// and is readable anonymously (no Authorization, X-Device-Id or signature headers are sent).
import { expect, it } from 'vitest';
import {
  DETAIL,
  detail,
  detailRaw,
  newAppId,
  newId,
  notFound,
  sameInstant,
  seedArticle,
  useHarness,
  UUID_RE,
  validate,
} from './kit.ts';

const h = useHarness('detail', () => import('@couli/db/testing'));

it('[AC-F1-02f#7] a published article is returned whole, anonymously, and passes ArticleResponse', async () => {
  const appId = newAppId();
  const row = await seedArticle(h.db, {
    id: newId(),
    appId,
    category: 'agreement',
    title: '用户协议',
    body: '第一条\r\n  第二条\t<script>不执行</script>\n\n',
  });
  expect(row.id).toMatch(UUID_RE);
  const response = await detailRaw(h, appId, row.id);
  expect(response.statusCode).toBe(200);
  await validate(response, DETAIL);
  const body = response.json<{ code: number; data: Record<string, unknown> }>();
  expect(body.code).toBe(0);
  expect(body.data).toEqual({
    article_id: row.id,
    category: 'agreement',
    title: '用户协议',
    version: 1,
    published_at: body.data['published_at'],
    body: '第一条\r\n  第二条\t<script>不执行</script>\n\n',
  });
  sameInstant(body.data['published_at'] as string, row.publishedAt);
  expect(await detail(h, appId, row.id, 1)).toEqual(body.data);
});

it('[AC-F1-02f#7] ids that are not lowercase canonical UUIDs are 404 / 30701, never 500', async () => {
  const appId = newAppId();
  const row = await seedArticle(h.db, { id: newId(), appId, category: 'help' });
  // Sanity: the canonical form is readable, so the variants below fail on their form alone.
  expect((await detail(h, appId, row.id)).article_id).toBe(row.id);
  const variants = [
    'abc',
    'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
    row.id.toUpperCase(),
    `{${row.id}}`,
    row.id.replaceAll('-', ''),
    `${row.id.slice(0, 35)}g`,
    `urn:uuid:${row.id}`,
    'a'.repeat(64),
    "0' OR '1'='1",
  ];
  for (const id of variants) {
    await notFound(await detailRaw(h, appId, id));
    await notFound(await detailRaw(h, appId, id, 1));
  }
});

it('[AC-F1-02f#7] an unknown UUID or another app’s article is 404 / 30701', async () => {
  const appId = newAppId();
  const other = newAppId();
  const foreign = await seedArticle(h.db, { id: newId(), appId: other, category: 'help' });
  expect((await detail(h, other, foreign.id)).article_id).toBe(foreign.id);

  await notFound(await detailRaw(h, appId, newId()));
  await notFound(await detailRaw(h, appId, foreign.id));
  await notFound(await detailRaw(h, appId, foreign.id, 1));
});

it('[AC-F1-02f#7] an id above 64 characters or a version below 1 fails route validation with 20001', async () => {
  const appId = newAppId();
  const row = await seedArticle(h.db, { id: newId(), appId, category: 'rule' });
  for (const url of [
    `/v1/articles/${'a'.repeat(65)}`,
    `/v1/articles/${row.id}?version=0`,
    `/v1/articles/${row.id}?version=abc`,
  ]) {
    const response = await h.get(appId, url);
    expect(response.statusCode, url).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    await validate(response, DETAIL);
  }
  expect((await detail(h, appId, row.id)).category).toBe('rule');
});
