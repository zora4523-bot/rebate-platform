import pino from 'pino';
import { expect, it } from 'vitest';
import type { AuditInput, Clock, LinkPatternsSpec } from '../../platform/index.ts';
import type { AgreementType } from '../domain/agreements/index.ts';
import {
  AgreementAdmin,
  AgreementConflictError,
  AgreementFieldsError,
  AgreementNotFoundError,
  legalKeysOf,
  mediaHostsOf,
  mergeFields,
  type AgreementActor,
  type AgreementPublishBody,
  type AgreementStore,
  type AgreementTx,
  type ArticleRevision,
  type ConfigRow,
  type CurrentAgreementVersion,
  type LegalConfigWrite,
  type NewAgreementRow,
  type NewArticleRow,
} from './agreement-admin.ts';

const APP = 'app_a';
const AT = new Date(Date.UTC(2026, 9, 19, 2));
const BODY =
  '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}';

// Synthetic union host: specs/link-patterns.yaml has no real platform domains yet.
const PATTERNS: LinkPatternsSpec = {
  version: 'synthetic',
  rules: [
    {
      platform: 'taobao',
      category: 'union_host',
      hosts: ['union.example.test'],
      path_patterns: [],
    },
  ],
};

const clock: Clock = { now: () => AT };
const actor: AgreementActor = { appId: APP, adminId: 'admin-1', loginName: 'ops', ip: null };

function body(patch: Partial<AgreementPublishBody> = {}): AgreementPublishBody {
  return {
    title: '协议',
    body: BODY,
    min_version: 1,
    requires_resign: false,
    legal_confirmed_by: '法务',
    legal_confirm_note: '已确认',
    legal_confirmed_on: '2026-10-18',
    expected_version: 0,
    ...patch,
  };
}

interface Memory {
  current: CurrentAgreementVersion | undefined;
  config: Map<string, ConfigRow>;
  revisions: ArticleRevision[];
  calls: string[];
  articles: NewArticleRow[];
  agreements: NewAgreementRow[];
  writes: LegalConfigWrite[];
  history: [string, number][];
  audits: AuditInput[];
  failAgreementInsert?: unknown;
}

function memory(seed: Partial<Memory> = {}): { store: AgreementStore; m: Memory } {
  const m: Memory = {
    current: undefined,
    config: new Map([['h5_base_url', { value: 'https://h5.example.test/', version: 1 }]]),
    revisions: [],
    calls: [],
    articles: [],
    agreements: [],
    writes: [],
    history: [],
    audits: [],
    ...seed,
  };
  const tx: AgreementTx = {
    lock: async (appId, type) => {
      m.calls.push(`lock:${appId}:${type}`);
    },
    current: async () => {
      m.calls.push('current');
      return m.current;
    },
    configValue: async (_appId, key) => m.config.get(key)?.value,
    lockConfig: async (_appId, key) => m.config.get(key),
    articleRevisions: async () => m.revisions,
    insertArticle: async (row) => {
      m.calls.push('article');
      m.articles.push(row);
    },
    insertAgreement: async (row) => {
      m.calls.push('agreement');
      if (m.failAgreementInsert !== undefined) throw m.failAgreementInsert;
      m.agreements.push(row);
    },
    writeConfig: async (input) => {
      m.calls.push(`config:${input.key}`);
      m.writes.push(input);
      return (input.existing?.version ?? 0) + 1;
    },
    history: async (input, version) => {
      m.history.push([input.key, version]);
    },
    audit: async (input) => {
      m.calls.push('audit');
      m.audits.push(input);
    },
  };
  const store: AgreementStore = {
    list: async (_appId, _type, offset, limit) => ({
      items: [],
      total: offset + limit,
    }),
    detail: async () => undefined,
    transaction: (work) => work(tx),
  };
  return { store, m };
}

function admin(store: AgreementStore, media: string | null = 'https://media.example.test/a/') {
  let id = 0;
  return new AgreementAdmin({
    store,
    clock,
    logger: pino({ enabled: false }),
    mediaPublicBaseUrl: media ?? undefined,
    linkPatterns: () => PATTERNS,
    newId: () => `00000000-0000-7000-8000-00000000000${String(++id)}`,
    isVersionTaken: (error) => error === 'taken',
  });
}

async function fields(work: Promise<unknown>): Promise<readonly string[]> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AgreementFieldsError);
  return (error as AgreementFieldsError).fields;
}

it('[AC-F1-02p] first privacy publish writes article, agreement, both legal keys and audit in order', async () => {
  const { store, m } = memory();
  const row = await admin(store).publish(actor, 'privacy', body());
  expect(m.calls).toEqual([
    'lock:app_a:privacy',
    'current',
    'article',
    'agreement',
    'config:legal.privacy.version',
    'config:legal.privacy.min_version',
    'audit',
  ]);
  expect(row).toMatchObject({
    version: 1,
    article_version: 1,
    url: 'https://h5.example.test/agreement?type=privacy&version=1',
    published_at: AT.toISOString(),
    published_by: 'admin-1',
  });
  expect(m.articles[0]).toMatchObject({ version: 1, rowVersion: 0, at: AT });
  expect(m.history).toEqual([
    ['legal.privacy.version', 1],
    ['legal.privacy.min_version', 1],
  ]);
  expect(m.audits[0]).toMatchObject({ action: 'agreement_publish', before: null });
  expect(JSON.stringify(m.audits)).not.toContain(BODY);
});

it('[AC-F1-02p] stale expected_version is a conflict before any check or write', async () => {
  const { store, m } = memory();
  await expect(
    admin(store).publish(actor, 'privacy', body({ expected_version: 1, title: '\t' })),
  ).rejects.toBeInstanceOf(AgreementConflictError);
  expect(m.articles).toEqual([]);
});

it('[AC-F1-02p] a unique violation on the version key maps to a conflict after the transaction', async () => {
  const { store } = memory({ failAgreementInsert: 'taken' });
  await expect(admin(store).publish(actor, 'privacy', body())).rejects.toBeInstanceOf(
    AgreementConflictError,
  );
  const other = memory({ failAgreementInsert: new Error('boom') });
  await expect(admin(other.store).publish(actor, 'privacy', body())).rejects.toThrow('boom');
});

it('[AC-F1-02p] JS-trim blank confirmer, note and title are refused (btrim keeps tabs)', async () => {
  const { store, m } = memory();
  expect(
    await fields(
      admin(store).publish(
        actor,
        'privacy',
        body({ legal_confirmed_by: '\t', legal_confirm_note: '　\n', title: ' 　' }),
      ),
    ),
  ).toEqual(['legal_confirmed_by', 'legal_confirm_note', 'title']);
  expect(m.calls).not.toContain('article');
});

it('[AC-F1-02p] field names come before body paths, deduplicated', () => {
  expect(
    mergeFields(
      [
        ['min_version', 'body'],
        ['title', 'body'],
      ],
      ['content[0]'],
    ),
  ).toEqual(['min_version', 'body', 'title', 'content[0]']);
});

it('[AC-F1-02p] images are allowed only on the media host; none without MEDIA_PUBLIC_BASE_URL', async () => {
  const image = JSON.stringify({
    type: 'doc',
    content: [{ type: 'image', attrs: { src: 'https://media.example.test/a/x.png' } }],
  });
  expect(mediaHostsOf('https://media.example.test/a/')).toEqual(['media.example.test']);
  expect(mediaHostsOf(undefined)).toEqual([]);
  expect(mediaHostsOf('not a url')).toEqual([]);
  await expect(
    admin(memory().store).publish(actor, 'privacy', body({ body: image })),
  ).resolves.toMatchObject({ version: 1 });
  expect(
    await fields(admin(memory().store, null).publish(actor, 'privacy', body({ body: image }))),
  ).toEqual(['body', 'content[0].attrs.src']);
});

it('[AC-F1-02p] agreement text is not scanned for banned words (L42)', async () => {
  const text = BODY.replace('"x"', '"佣金 返现 结算中"');
  await expect(
    admin(memory().store).publish(actor, 'privacy', body({ title: '原价', body: text })),
  ).resolves.toMatchObject({ version: 1 });
});

for (const value of [undefined, 'http://h5.example.test/', 42]) {
  it(`[AC-F1-02p] h5_base_url ${String(value)} fails closed before any write`, async () => {
    const config = new Map<string, ConfigRow>();
    if (value !== undefined) config.set('h5_base_url', { value, version: 1 });
    const { store, m } = memory({ config });
    await expect(admin(store).publish(actor, 'privacy', body())).rejects.toThrow('h5_base_url');
    expect(m.calls).toEqual(['lock:app_a:privacy', 'current']);
  });
}

for (const type of ['privacy', 'agreement'] as const) {
  it(`[AC-F1-02p] legal.${type}.version at or past the new version is never overwritten (L44)`, async () => {
    const { store, m } = memory();
    m.config.set(`legal.${type}.version`, { value: 1, version: 3 });
    await expect(admin(store).publish(actor, type, body())).rejects.toThrow(
      `legal.${type}.version`,
    );
    expect(m.calls).not.toContain('article');
    m.config.set(`legal.${type}.version`, { value: 'manual', version: 3 });
    await expect(admin(store).publish(actor, type, body())).resolves.toMatchObject({
      version: 1,
    });
  });
}

it('[AC-F1-02p] legal keys per type (L24)', () => {
  expect(legalKeysOf('privacy').map((k) => k.key)).toEqual([
    'legal.privacy.version',
    'legal.privacy.min_version',
  ]);
  expect(legalKeysOf('agreement').map((k) => k.key)).toEqual(['legal.agreement.version']);
  expect(legalKeysOf('labor_agreement')).toEqual([]);
});

it('[AC-F1-02p] next version reuses the article id at max revision + 1 and its row_version + 1', async () => {
  const { store, m } = memory({
    current: { version: 1, min_version: 1, requires_resign: true, article_id: 'art-1' },
    revisions: [
      { app_id: APP, version: 1, row_version: 0 },
      { app_id: APP, version: 7, row_version: 12 },
    ],
  });
  const type: AgreementType = 'labor_agreement';
  const row = await admin(store).publish(actor, type, body({ expected_version: 1 }));
  expect(row).toMatchObject({ version: 2, article_id: 'art-1', article_version: 8 });
  expect(m.articles[0]).toMatchObject({ id: 'art-1', version: 8, rowVersion: 13 });
  expect(m.writes).toEqual([]);
  expect(m.audits[0]?.before).toEqual({ version: 1, min_version: 1, requires_resign: true });
});

it('[AC-F1-02p] an agreement article stored under another app fails closed (§9.12 ③)', async () => {
  const { store, m } = memory({
    current: { version: 1, min_version: 1, requires_resign: false, article_id: 'art-x' },
    revisions: [{ app_id: 'app_b', version: 1, row_version: 0 }],
  });
  await expect(
    admin(store).publish(actor, 'privacy', body({ expected_version: 1 })),
  ).rejects.toThrow('another app');
  expect(m.articles).toEqual([]);
  const missing = memory({
    current: { version: 1, min_version: 1, requires_resign: false, article_id: 'art-x' },
  });
  await expect(
    admin(missing.store).publish(actor, 'privacy', body({ expected_version: 1 })),
  ).rejects.toThrow('no article');
});

it('[AC-F1-02p] reads page with defaults and an unknown version is not found', async () => {
  const { store } = memory();
  await expect(admin(store).list(APP, { page: 2, page_size: 5 })).resolves.toEqual({
    items: [],
    page: 2,
    page_size: 5,
    total: 10,
  });
  await expect(admin(store).list(APP)).resolves.toMatchObject({ page: 1, page_size: 20 });
  await expect(admin(store).detail(APP, 'privacy', 3)).rejects.toBeInstanceOf(
    AgreementNotFoundError,
  );
});

it('[AC-F1-02p] a union link is refused unless external_page.union_host_block is false', async () => {
  const link = JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'a',
            marks: [{ type: 'link', attrs: { href: 'https://shop.union.example.test/item?id=1' } }],
          },
        ],
      },
    ],
  });
  expect(
    await fields(admin(memory().store).publish(actor, 'privacy', body({ body: link }))),
  ).toEqual(['body', 'content[0].content[0].marks[0].attrs.href']);
  const off = memory();
  off.m.config.set('external_page.union_host_block', { value: false, version: 1 });
  await expect(
    admin(off.store).publish(actor, 'privacy', body({ body: link })),
  ).resolves.toMatchObject({ version: 1 });
});
