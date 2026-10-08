import { afterEach, expect, it, vi } from 'vitest';
import { CatalogModule } from '../../../../apps/api/src/modules/catalog/index.ts';
import { createSearchCursorCodec } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import {
  searchProducts,
  type SearchCursorCodec,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import { candidate, fixture, observed } from '../search/kit.ts';
import { createApp } from '../search-route/http-kit.ts';

afterEach(() => vi.restoreAllMocks());

function forged(claims: { search_session_id: string; page_no: number }): string {
  return Buffer.from(JSON.stringify(claims)).toString('base64url');
}

/** Alter only the payload when the wire carries a readable signed JSON segment. */
function tamper(wire: string, field: 'page_no' | 'search_session_id'): string {
  const segments = wire.split('.');
  for (let index = 0; index < segments.length; index++) {
    try {
      const value = JSON.parse(
        Buffer.from(segments[index]!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      if (typeof value['page_no'] !== 'number' || typeof value['search_session_id'] !== 'string')
        continue;
      value[field] = field === 'page_no' ? 3 : 'synthetic-forged-session';
      segments[index] = Buffer.from(JSON.stringify(value)).toString('base64url');
      return segments.join('.');
    } catch {
      /* An opaque/encrypted segment; try the next segment. */
    }
  }
  const index = Math.floor(wire.length / 2);
  return wire.slice(0, index) + (wire[index] === 'A' ? 'B' : 'A') + wire.slice(index + 1);
}

it('[AC-B1-05g#18] 手造 JSON、改页号、改会话或截断签名都先拒绝 20001 且不调联盟', async () => {
  const f = fixture();
  const codec = createSearchCursorCodec();
  const options = { ...f.options, cursors: codec };
  f.pages.set(1, { items: [candidate('cursor')], hasMore: true });
  const first = await searchProducts({ platform: 'taobao', q: 'synthetic', limit: 1 }, options);
  expect(first.next_cursor).toEqual(expect.any(String));
  const wire = first.next_cursor!;
  for (const invalid of [
    forged({ search_session_id: 'synthetic-session-1', page_no: 2 }),
    tamper(wire, 'page_no'),
    tamper(wire, 'search_session_id'),
    wire.slice(0, -4),
  ]) {
    f.search.mockClear();
    const result = await observed(() =>
      searchProducts({ platform: 'taobao', q: 'synthetic', limit: 1, cursor: invalid }, options),
    );
    expect(result.kind === 'rejected' ? (result.error as { code?: number }).code : null).toBe(
      20001,
    );
    expect(f.search).not.toHaveBeenCalled();
  }
});

it('[AC-B1-05g#19] 有效签名也受 page_no 100 上限约束，101 与超大整数均为 20001', async () => {
  const f = fixture();
  const codec = createSearchCursorCodec();
  const claims = { search_session_id: 'synthetic-limit-session', page_no: 100 };
  expect(codec.decode(codec.encode(claims))).toEqual(claims);
  for (const pageNo of [101, Number.MAX_SAFE_INTEGER]) {
    const result = await observed(async () =>
      searchProducts(
        {
          platform: 'taobao',
          q: 'synthetic',
          cursor: codec.encode({ ...claims, page_no: pageNo }),
        },
        { ...f.options, cursors: codec },
      ),
    );
    expect(result.kind === 'rejected' ? (result.error as { code?: number }).code : null).toBe(
      20001,
    );
    expect(f.search).not.toHaveBeenCalled();
  }
});

class CursorProbe {
  readonly codec: SearchCursorCodec;
  constructor(codec: SearchCursorCodec) {
    this.codec = codec;
  }
}

const originalModule = CatalogModule.forRoot;

it('[AC-B1-05g#20] 同进程重建真实 AppModule 后旧游标仍验签，伪造游标不能验过', async () => {
  const f = fixture();
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((config) => {
    const module = originalModule(config);
    const provider = (module.providers ?? []).find(
      (entry) =>
        typeof entry === 'object' &&
        typeof entry.provide === 'symbol' &&
        entry.provide.description === 'CATALOG_SEARCH_CURSORS',
    );
    expect(provider).toBeDefined();
    if (provider === undefined || typeof provider !== 'object') return module;
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        {
          provide: CursorProbe,
          inject: [provider.provide],
          useFactory: (codec: SearchCursorCodec) => new CursorProbe(codec),
        },
      ],
      exports: [...(module.exports ?? []), CursorProbe],
    };
  });
  const claims = { search_session_id: 'synthetic-rebuilt-app', page_no: 2 };
  const first = await createApp(f.clock);
  let wire: string;
  try {
    await first.init();
    wire = (await first.resolve(CursorProbe)).codec.encode(claims);
  } finally {
    await first.close();
  }
  const second = await createApp(f.clock);
  try {
    await second.init();
    const codec = (await second.resolve(CursorProbe)).codec;
    expect(codec.decode(wire)).toEqual(claims);
    expect(codec.decode(forged(claims))).not.toEqual(claims);
    expect(codec.decode(tamper(wire, 'page_no'))).not.toMatchObject({ page_no: 3 });
  } finally {
    await second.close();
  }
});
