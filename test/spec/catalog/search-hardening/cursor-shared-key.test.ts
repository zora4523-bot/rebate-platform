import { expect, it } from 'vitest';
import { createSignedSearchCursorCodec } from '../../../../apps/api/src/modules/catalog/infra/search-cursor.ts';
import { searchProducts } from '../../../../apps/api/src/modules/catalog/search.ts';
import { candidate, fixture, observed } from '../search/kit.ts';

it('[AC-B1-05g#31] 部署共享密钥的独立编解码实例互验，其他密钥的游标返回 20001', async () => {
  // Synthetic ASCII seeds, encoded at runtime; equal bytes in distinct allocations.
  const a = createSignedSearchCursorCodec(Buffer.from('a'.repeat(32), 'ascii'));
  const b = createSignedSearchCursorCodec(Buffer.from('a'.repeat(32), 'ascii'));
  const other = createSignedSearchCursorCodec(Buffer.from('b'.repeat(32), 'ascii'));
  const claimsA = { search_session_id: 'synthetic-shared-session-a', page_no: 2 };
  const claimsB = { search_session_id: 'synthetic-shared-session-b', page_no: 3 };
  expect(b.decode(a.encode(claimsA))).toEqual(claimsA);
  expect(a.decode(b.encode(claimsB))).toEqual(claimsB);

  const f = fixture();
  const query = { platform: 'taobao' as const, q: 'synthetic', limit: 1 };
  f.pages.set(1, { items: [candidate('shared-first')], hasMore: true });
  f.pages.set(2, { items: [candidate('shared-second')], hasMore: false });
  const first = await searchProducts(query, { ...f.options, cursors: a });
  expect(first.next_cursor).toEqual(expect.any(String));
  const claims = b.decode(first.next_cursor!) as { search_session_id: string; page_no: number };
  expect(claims).toMatchObject({ search_session_id: expect.any(String), page_no: 2 });
  f.search.mockClear();
  const continued = await observed(() =>
    searchProducts({ ...query, cursor: first.next_cursor! }, { ...f.options, cursors: b }),
  );
  expect(continued).toMatchObject({
    kind: 'returned',
    value: { items: [{ title: 'synthetic-shared-second' }] },
  });
  expect(f.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pageNo: 2 }));

  // Valid claims and live session, but signed by an unrelated deployment key.
  for (const [issuer, verifier] of [
    [other, a],
    [a, other],
  ] as const) {
    f.search.mockClear();
    const rejected = await observed(() =>
      searchProducts(
        { ...query, cursor: issuer.encode(claims) },
        { ...f.options, cursors: verifier },
      ),
    );
    expect(rejected).toMatchObject({ kind: 'rejected', error: { code: 20001 } });
    expect(f.search).not.toHaveBeenCalled();
    expect(f.materialFeed).not.toHaveBeenCalled();
  }
});
