import { describe, expect, it } from 'vitest';
import { MediaStoreUnavailableError } from '../../platform/index.ts';
import {
  PlatformIconFieldsError,
  PlatformIconReader,
  type PlatformIconRow,
  type PlatformIconStore,
  type PlatformIconVersionRow,
} from './platform-icon-reader.ts';

const BASE = 'https://media.example.invalid/m/';
const DIGEST = 'a'.repeat(64);

function versionRow(version: number, patch: Partial<PlatformIconVersionRow> = {}) {
  return {
    version,
    sha256: DIGEST,
    format: 'svg',
    bytes: 10,
    sanitized: false,
    sourceUrl: null,
    downloadedOn: null,
    everPublished: false,
    revision: 1,
    createdBy: 'ops',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...patch,
  } satisfies PlatformIconVersionRow;
}

function store(
  icons: PlatformIconRow[] = [],
  latest: [string, number][] = [],
  page: PlatformIconVersionRow[] = [],
) {
  const calls: unknown[][] = [];
  const port: PlatformIconStore = {
    icons: () => Promise.resolve(icons),
    latestVersions: () => Promise.resolve(new Map(latest)),
    versionPage: (...args) => {
      calls.push(args);
      return Promise.resolve({ total: page.length, items: page });
    },
  };
  return { port, calls };
}

describe('PlatformIconReader.list', () => {
  it('[AC-F1-06w#1] answers every key in enum order, built-in where there is no row', async () => {
    const reader = new PlatformIconReader(store().port, BASE);
    const { items } = await reader.list('app');
    expect(items.map((item) => item.key)).toEqual([
      'taobao',
      'tmall',
      'jd',
      'pdd',
      'wechat',
      'wechat_pay',
      'alipay',
      'wecom',
    ]);
    expect(items[0]).toEqual({
      key: 'taobao',
      current_version: null,
      revision: 0,
      current: null,
      latest_version: null,
      updated_by: null,
      updated_at: null,
    });
  });

  it('[AC-F1-06w#2] maps the current version with its url and the newest saved number', async () => {
    const reader = new PlatformIconReader(
      store(
        [
          {
            key: 'jd',
            currentVersion: 2,
            revision: 8,
            updatedBy: 'editor',
            updatedAt: new Date('2026-10-03T00:00:00.000Z'),
            current: versionRow(2, {
              format: 'png',
              sourceUrl: 'https://s.example.invalid',
              downloadedOn: '2026-10-01',
            }),
          },
        ],
        [['jd', 3]],
      ).port,
      BASE,
    );
    const jd = (await reader.list('app')).items[2]!;
    expect(jd).toMatchObject({
      key: 'jd',
      current_version: 2,
      revision: 8,
      latest_version: 3,
      updated_by: 'editor',
      updated_at: '2026-10-03T00:00:00.000Z',
      current: {
        version: 2,
        url: `https://media.example.invalid/m/${DIGEST}.png`,
        publishable: true,
        downloaded_on: '2026-10-01',
      },
    });
  });

  it('[AC-F1-06w#15] needs the media base only when a version is answered', async () => {
    const draftOnly = new PlatformIconReader(store([], [['jd', 1]]).port, undefined);
    expect((await draftOnly.list('app')).items[2]).toMatchObject({ latest_version: 1 });
    const published = new PlatformIconReader(
      store([
        {
          key: 'jd',
          currentVersion: 1,
          revision: 1,
          updatedBy: 'e',
          updatedAt: new Date(0),
          current: versionRow(1),
        },
      ]).port,
      undefined,
    );
    await expect(published.list('app')).rejects.toBeInstanceOf(MediaStoreUnavailableError);
  });
});

describe('PlatformIconReader.versions', () => {
  it('[AC-F1-06w#4] defaults to page 1 of 20 and passes offset and limit', async () => {
    const { port, calls } = store([], [], [versionRow(2), versionRow(1)]);
    const reader = new PlatformIconReader(port, BASE);
    expect(await reader.versions('app', 'pdd', {})).toMatchObject({
      page: 1,
      page_size: 20,
      total: 2,
    });
    await reader.versions('app', 'pdd', { page: 3, page_size: 200 });
    await reader.versions('app', 'pdd', { page: '2', page_size: '5' });
    expect(calls).toEqual([
      ['app', 'pdd', 0, 20],
      ['app', 'pdd', 400, 200],
      ['app', 'pdd', 5, 5],
    ]);
  });

  it('[AC-F1-06w#3] publishable needs both source and download date', async () => {
    const reader = new PlatformIconReader(
      store(
        [],
        [],
        [
          versionRow(3, { sourceUrl: 'https://s.example.invalid' }),
          versionRow(2, { downloadedOn: '2026-10-01' }),
          versionRow(1, { sourceUrl: 'https://s.example.invalid', downloadedOn: '2026-10-01' }),
        ],
      ).port,
      BASE,
    );
    const { items } = await reader.versions('app', 'tmall', {});
    expect(items.map((item) => item.publishable)).toEqual([false, false, true]);
  });

  it.each([
    [{ page: 0 }, ['page']],
    [{ page: 1.5 }, ['page']],
    [{ page: 'no' }, ['page']],
    [{ page_size: 201 }, ['page_size']],
    [{ page_size: 0 }, ['page_size']],
    [{ page: -1, page_size: 201 }, ['page', 'page_size']],
  ])('[AC-F1-06w#8] %o is 20001 naming %o', async (query, fields) => {
    const { port, calls } = store();
    const reader = new PlatformIconReader(port, BASE);
    const error = await reader.versions('app', 'jd', query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformIconFieldsError);
    expect((error as PlatformIconFieldsError).fields).toEqual(fields);
    expect(calls).toEqual([]);
  });

  it.each(['unknown', 'TAOBAO', 'constructor', 'wechat-pay'])(
    '[AC-F1-06w#9] key %s outside the enum is 20001 naming key',
    async (key) => {
      const reader = new PlatformIconReader(store().port, BASE);
      await expect(reader.versions('app', key, {})).rejects.toMatchObject({ fields: ['key'] });
    },
  );
});
