import { expect, it } from 'vitest';
import { createSearchCursorCodec } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import { searchProducts } from '../../../../apps/api/src/modules/catalog/search.ts';
import { candidate, fixture, observed } from '../search/kit.ts';

it('[AC-B1-05g#30] 搜索用例接受有效游标的第 100 页，第 101 页在联盟调用前拒绝 20001', async () => {
  const f = fixture();
  const codec = createSearchCursorCodec();
  const options = { ...f.options, cursors: codec };
  const query = { platform: 'taobao' as const, q: 'synthetic', limit: 1 };
  f.pages.set(1, { items: [candidate('first')], hasMore: true });
  f.pages.set(100, { items: [candidate('last')], hasMore: false });
  const first = await searchProducts(query, options);
  expect(first.next_cursor).toEqual(expect.any(String));
  const claims = codec.decode(first.next_cursor!) as { search_session_id: string };
  expect(claims).toHaveProperty('search_session_id', expect.any(String));

  f.search.mockClear();
  const allowed = await observed(() =>
    searchProducts(
      {
        ...query,
        cursor: codec.encode({ search_session_id: claims.search_session_id, page_no: 100 }),
      },
      options,
    ),
  );
  expect(allowed).toMatchObject({
    kind: 'returned',
    value: { items: [{ title: 'synthetic-last' }] },
  });
  expect(f.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pageNo: 100 }));

  f.search.mockClear();
  const denied = await observed(async () =>
    searchProducts(
      {
        ...query,
        cursor: codec.encode({ search_session_id: claims.search_session_id, page_no: 101 }),
      },
      options,
    ),
  );
  expect(denied).toMatchObject({ kind: 'rejected', error: { code: 20001 } });
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
});
