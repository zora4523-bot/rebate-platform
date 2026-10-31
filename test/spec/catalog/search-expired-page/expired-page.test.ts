// B1-05t rule tests (BR-PROD-08 细则「会话异常」, D10-485): a cursor that decodes but whose
// search_session_id has expired, left the store or belongs to another requester opens a new
// session and answers the requested page_no, without an error, the issued set starting empty.
// A changed filter or sort is the other new-session path and is deliberately not pinned here.
import { afterEach, expect, it, vi } from 'vitest';
import type { Viewer } from '../../../../apps/api/src/modules/catalog/index.ts';
import { createSignedSearchCursorCodec } from '../../../../apps/api/src/modules/catalog/infra/search-cursor.ts';
import { createUnionSearchUpstream } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import {
  searchProducts,
  type SearchCursor,
  type SearchProductsData,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import type { UnionAdapter, UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import { platformRow } from '../hot-rank-upstream/kit.ts';
import {
  WHITELIST,
  fakeAdapter,
  memoryRedis,
  tbItem,
  useCaseWhitelist,
} from '../search-fallback-channel/kit.ts';
import { NOW, QUERY, candidate, claims, fixture, observed } from '../search/kit.ts';

afterEach(() => vi.restoreAllMocks());

type Fixture = ReturnType<typeof fixture>;

const APP = 'synthetic-app';
const LIMIT = 2;
/** One millisecond past BR-PROD-08 ②'s 30 minutes without a request. */
const PAST_EXPIRY_MS = 30 * 60 * 1000 + 1;
const UNION_CURSOR = 'synthetic-union-';

const LAPSES = [
  {
    name: '会话 30 分钟无请求过期',
    lapse: (f: Fixture): void => f.clock.advanceMs(PAST_EXPIRY_MS),
  },
  { name: '会话行已从存储删除', lapse: (f: Fixture): void => f.sessions.rows.clear() },
];

const FOREIGN: readonly { name: string; owner: Partial<Viewer>; other: Partial<Viewer> }[] = [
  {
    name: '别的登录用户',
    owner: { userId: 'synthetic-user', deviceId: 'synthetic-device' },
    other: { userId: 'synthetic-other-user', deviceId: 'synthetic-device' },
  },
  {
    name: '别的游客设备',
    owner: { userId: null, deviceId: 'synthetic-device' },
    other: { userId: null, deviceId: 'synthetic-other-device' },
  },
  {
    name: '同设备未登录的游客',
    owner: { userId: 'synthetic-user', deviceId: 'synthetic-device' },
    other: { userId: null, deviceId: 'synthetic-device' },
  },
];

function titles(data: SearchProductsData): (string | null)[] {
  return data.items.map((card) => card.title);
}

function pageNos(f: Fixture): number[] {
  return f.search.mock.calls.map(([input]) => input.pageNo);
}

/** Pages 1..4 are full and share nothing, so no request refills or drops a card. */
function distinctPages(f: Fixture): void {
  for (let pageNo = 1; pageNo <= 4; pageNo += 1) {
    f.pages.set(pageNo, {
      items: [candidate(`p${pageNo}-a`), candidate(`p${pageNo}-b`)],
      hasMore: true,
    });
  }
}

/** Pages through a live session up to the cursor that asks for page 3. */
async function cursorOfPage3(f: Fixture): Promise<{ cursor: string; sessionId: string }> {
  const first = await f.run({ limit: LIMIT });
  const second = await f.run({ limit: LIMIT, cursor: first.next_cursor! });
  const cursor = second.next_cursor!;
  expect(claims(f, cursor)).toMatchObject({ page_no: 3 });
  f.search.mockClear();
  return { cursor, sessionId: claims(f, cursor).search_session_id };
}

it.each(LAPSES)(
  '[AC-B1-05t#1] $name 后带第 3 页游标：返回上游第 3 页的条目，不回第 1 页、不报错',
  async ({ lapse }) => {
    const f = fixture();
    distinctPages(f);
    const { cursor } = await cursorOfPage3(f);
    lapse(f);
    const result = await f.run({ limit: LIMIT, cursor });
    expect(titles(result)).toEqual(['synthetic-p3-a', 'synthetic-p3-b']);
    expect(pageNos(f)).toEqual([3]);
    expect(result.fallback_items).toEqual([]);
  },
);

it.each(FOREIGN)(
  '[AC-B1-05t#2] 游标属于$name：返回上游第 3 页，不串对方的已下发集合，对方会话不受影响',
  async ({ owner, other }) => {
    const f = fixture();
    f.setViewer(owner);
    const shared = candidate('shared');
    f.pages.set(1, { items: [shared, candidate('p1')], hasMore: true });
    f.pages.set(2, { items: [candidate('p2-a'), candidate('p2-b')], hasMore: true });
    f.pages.set(3, { items: [shared, candidate('p3')], hasMore: true });
    const { cursor, sessionId } = await cursorOfPage3(f);
    const ownerSession = await f.sessions.read(APP, sessionId);

    f.setViewer(other);
    const result = await f.run({ limit: LIMIT, cursor });
    expect(titles(result)).toEqual(['synthetic-shared', 'synthetic-p3']);
    expect(pageNos(f)).toEqual([3]);
    expect(claims(f, result.next_cursor)).toEqual({
      search_session_id: expect.any(String),
      page_no: 4,
    });
    expect(claims(f, result.next_cursor)?.search_session_id).not.toBe(sessionId);
    expect(await f.sessions.read(APP, sessionId)).toEqual(ownerSession);

    f.setViewer(owner);
    const resumed = await f.run({ limit: LIMIT, cursor });
    expect(titles(resumed)).toEqual(['synthetic-p3']);
  },
);

it.each(LAPSES)(
  '[AC-B1-05t#3] $name 后已下发集合从空开始：过期前第 1 页下发过的 key 重新出现在第 3 页时照常下发',
  async ({ lapse }) => {
    const f = fixture();
    const repeated = candidate('repeated');
    const fresh = candidate('p3');
    f.pages.set(1, { items: [repeated, candidate('p1')], hasMore: true });
    f.pages.set(2, { items: [candidate('p2-a'), candidate('p2-b')], hasMore: true });
    f.pages.set(3, { items: [repeated, fresh], hasMore: true });
    const { cursor } = await cursorOfPage3(f);
    lapse(f);
    const result = await f.run({ limit: LIMIT, cursor });
    expect(titles(result)).toEqual(['synthetic-repeated', 'synthetic-p3']);
    const session = await f.sessions.read(APP, claims(f, result.next_cursor)?.search_session_id);
    expect(session?.seen).toEqual([repeated.ref.productKey, fresh.ref.productKey]);
  },
);

it.each(LAPSES)(
  '[AC-B1-05t#4] $name 后下发的 next_cursor 带新的 search_session_id，page_no 是请求页 + 1',
  async ({ lapse }) => {
    const f = fixture();
    distinctPages(f);
    const { cursor, sessionId } = await cursorOfPage3(f);
    lapse(f);
    const result = await f.run({ limit: LIMIT, cursor });
    expect(claims(f, result.next_cursor)).toEqual({
      search_session_id: expect.any(String),
      page_no: 4,
    });
    expect(claims(f, result.next_cursor)?.search_session_id).not.toBe(sessionId);
    expect(result.has_more).toBe(true);
  },
);

it('[AC-B1-05t#5] 新会话接着翻第 4 页：只剔除新会话下发过的 key，过期前下发的不算', async () => {
  const f = fixture();
  const before = candidate('before');
  const carried = candidate('carried');
  f.pages.set(1, { items: [before, candidate('p1')], hasMore: true });
  f.pages.set(2, { items: [candidate('p2-a'), candidate('p2-b')], hasMore: true });
  f.pages.set(3, { items: [carried, candidate('p3')], hasMore: true });
  f.pages.set(4, { items: [carried, before, candidate('p4')], hasMore: false });
  const { cursor } = await cursorOfPage3(f);
  f.clock.advanceMs(PAST_EXPIRY_MS);
  const restarted = await f.run({ limit: LIMIT, cursor });
  expect(titles(restarted)).toEqual(['synthetic-carried', 'synthetic-p3']);
  f.search.mockClear();
  const next = await f.run({ limit: LIMIT, cursor: restarted.next_cursor! });
  expect(titles(next)).toEqual(['synthetic-before', 'synthetic-p4']);
  expect(pageNos(f)).toEqual([4]);
});

it('[AC-B1-05t#6] 解不开的游标（格式、签名错）仍是 20001，不走新会话；同一过期会话的真游标才取第 3 页', async () => {
  const f = fixture();
  distinctPages(f);
  const codec = createSignedSearchCursorCodec(Buffer.from('a'.repeat(32), 'ascii'));
  const otherKey = createSignedSearchCursorCodec(Buffer.from('b'.repeat(32), 'ascii'));
  const options = { ...f.options, cursors: codec };
  const query = { ...QUERY, limit: LIMIT };
  const run = (cursor: string) => searchProducts({ ...query, cursor }, options);
  const first = await searchProducts(query, options);
  const second = await run(first.next_cursor!);
  const wire = second.next_cursor!;
  const decoded = codec.decode(wire) as SearchCursor;
  expect(decoded).toMatchObject({ page_no: 3 });
  f.clock.advanceMs(PAST_EXPIRY_MS);
  f.search.mockClear();
  f.sessions.write.mockClear();

  const payload = (value: SearchCursor): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const mac = wire.slice(wire.indexOf('.') + 1);
  for (const invalid of [
    'synthetic-not-a-cursor',
    payload(decoded),
    `${payload({ ...decoded, page_no: 4 })}.${mac}`,
    wire.slice(0, -4),
    otherKey.encode(decoded),
  ]) {
    const result = await observed(() => run(invalid));
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 20001 } });
  }
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.sessions.write).not.toHaveBeenCalled();

  // The same session, the same moment: only the cursor's validity separates 20001 from a new one.
  const expired = await run(wire);
  expect(titles(expired)).toEqual(['synthetic-p3-a', 'synthetic-p3-b']);
});

it('[AC-B1-05t#7] 新会话请求的页是空页：不报错、不回第 1 页，不算第一页无结果，不发 fallback_items', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  f.materialFeed.mockResolvedValue({ items: [candidate('feed')], hasMore: false });
  distinctPages(f);
  f.pages.delete(3);
  const { cursor } = await cursorOfPage3(f);
  f.clock.advanceMs(PAST_EXPIRY_MS);
  const result = await f.run({ limit: LIMIT, cursor });
  expect(result).toEqual({ items: [], next_cursor: null, has_more: false, fallback_items: [] });
  expect(pageNos(f)).toEqual([3]);
  expect(f.materialFeed).not.toHaveBeenCalled();
});

function unionItems(pageNo: number): UnionItem[] {
  return ['a', 'b'].map((name, index) =>
    tbItem(`p${pageNo}-${name}`, pageNo * 10 + index, { quotedAt: NOW }),
  );
}

/** A union that pages only by its own continuation cursor, as the real adapters do. */
const pagedAdapter: UnionAdapter = {
  ...fakeAdapter('taobao').adapter,
  searchItems: async ({ cursor }) => {
    const pageNo = cursor === undefined ? 1 : Number(cursor.slice(UNION_CURSOR.length));
    return { items: unionItems(pageNo), nextCursor: `${UNION_CURSOR}${pageNo + 1}` };
  },
};

it('[AC-B1-05t#8] 真实上游装配：会话过期时联盟续页游标也已不在，仍取到联盟第 3 页并能续第 4 页', async () => {
  const f = fixture();
  const ledger = memoryRedis();
  const upstream = createUnionSearchUpstream({
    union: { adapter: () => pagedAdapter },
    catalog: { listPlatforms: async () => [platformRow('taobao', 'tb')] },
    config: { configValue: async () => null },
    clock: f.clock,
    ledger: ledger.redis,
  });
  const options = { ...f.options, upstream };
  const query = { ...QUERY, limit: LIMIT };
  const first = await searchProducts(query, options);
  const second = await searchProducts({ ...query, cursor: first.next_cursor! }, options);
  expect(claims(f, second.next_cursor)).toMatchObject({ page_no: 3 });
  f.clock.advanceMs(PAST_EXPIRY_MS);
  ledger.rows.clear();
  const result = await searchProducts({ ...query, cursor: second.next_cursor! }, options);
  expect(titles(result)).toEqual(['synthetic-p3-a', 'synthetic-p3-b']);
  expect(claims(f, result.next_cursor)).toMatchObject({ page_no: 4 });
});
