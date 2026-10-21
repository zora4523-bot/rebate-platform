import { expect, it } from 'vitest';
import { FixedClock, type AuditInput, type LinkPatternsSpec } from '../../platform/index.ts';
import type { BannedWord } from '../domain/text-guard/index.ts';
import {
  ArticleAdmin,
  ArticleConflictError,
  ArticleFieldsError,
  ArticleNotFoundError,
  articleConfigKeysFor,
  articleFieldList,
  articleView,
  currentVersionOf,
  helpSectionRejected,
  withHelpSectionField,
  isNewArticleId,
  type ArticleAdminStore,
  type ArticleAdminTx,
  type ArticleRow,
} from './article-admin.ts';

const APP = 'f1_02w_unit';
const ID = '0199f102-aaaa-7000-8000-000000000001';
const NOW = '2026-10-09T02:00:00.000Z';
const ACTOR = { appId: APP, adminId: '00000000-0000-4000-8000-0000000000aa', ip: null };
const PATTERNS: LinkPatternsSpec = {
  version: 'unit',
  rules: [
    { platform: 'demo', category: 'union_host', hosts: ['union.example.test'], path_patterns: [] },
  ],
} as unknown as LinkPatternsSpec;
const WORDS: readonly BannedWord[] = [
  { word: '全网最低', category: 'unit', scopes: ['user_visible'] },
  {
    word: '比价',
    category: 'unit',
    scopes: ['user_visible'],
    allow_articles: [{ config_key: 'help_links.price_compare', fields: ['title', 'body'] }],
  },
];

function doc(text: string, href?: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
            ...(href === undefined ? {} : { marks: [{ type: 'link', attrs: { href } }] }),
          },
        ],
      },
    ],
  });
}

function row(extra: Partial<ArticleRow> = {}): ArticleRow {
  const at = new Date(NOW);
  return {
    id: ID,
    app_id: APP,
    category: 'help',
    title: '使用帮助',
    body: doc('说明'),
    version: 1,
    status: 'draft',
    published_at: null,
    notice_closable: true,
    notice_content_version: 1,
    notice_end_at: null,
    help_section: null,
    row_version: 0,
    created_at: at,
    updated_at: at,
    ...extra,
  };
}

/** In-memory store: committed only when the work resolves (a throw discards every write). */
function memory(initial: ArticleRow[] = [], config: Record<string, unknown> = {}) {
  const state = { rows: [...initial], audits: [] as AuditInput[], events: [] as string[] };
  const sorted = (rows: ArticleRow[], appId: string, id: string) =>
    rows.filter((r) => r.app_id === appId && r.id === id).sort((a, b) => b.version - a.version);
  const store: ArticleAdminStore = {
    list: () => Promise.reject(new Error('not used')),
    rows: async (appId, id) => sorted(state.rows, appId, id),
    async transaction(work) {
      const rows = state.rows.map((r) => ({ ...r }));
      const audits: AuditInput[] = [];
      const tx: ArticleAdminTx = {
        lock: async (appId, id) => {
          state.events.push('lock');
          return sorted(rows, appId, id).length > 0;
        },
        rows: async (appId, id) => sorted(rows, appId, id),
        taken: async (id) => rows.some((r) => r.id === id),
        configValue: async (_appId, key) => {
          state.events.push(`config:${key}`);
          return config[key];
        },
        insert: async (r) => {
          if (rows.some((x) => x.id === r.id && x.version === r.version)) {
            throw Object.assign(new Error('dup'), { code: '23505', constraint: 'articles_pkey' });
          }
          rows.push(r);
        },
        update: async (appId, id, version, expected, set) => {
          const index = rows.findIndex(
            (r) => r.app_id === appId && r.id === id && r.version === version,
          );
          if (index < 0 || rows[index]!.row_version !== expected) return false;
          rows[index] = { ...rows[index]!, ...set };
          return true;
        },
        audit: async (input) => {
          audits.push(input);
        },
      };
      const result = await work(tx);
      state.rows = rows;
      state.audits.push(...audits);
      return result;
    },
  };
  return { store, state };
}

function admin(store: ArticleAdminStore, clock = new FixedClock(NOW), media?: string) {
  return new ArticleAdmin({
    store,
    clock,
    mediaPublicBaseUrl: media,
    linkPatterns: () => PATTERNS,
    bannedWords: () => WORDS,
    isVersionTaken: (error) =>
      (error as { code?: string; constraint?: string }).code === '23505' &&
      (error as { constraint?: string }).constraint === 'articles_pkey',
  });
}

async function fieldsOf(promise: Promise<unknown>): Promise<readonly string[]> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ArticleFieldsError);
  return (error as ArticleFieldsError).fields;
}

it('[AC-F1-02w#12] new ids are lowercase canonical UUIDv7 only', () => {
  expect(isNewArticleId(ID)).toBe(true);
  expect(isNewArticleId(ID.toUpperCase())).toBe(false);
  expect(isNewArticleId('0199f102-aaaa-4000-8000-000000000001')).toBe(false);
  expect(isNewArticleId('0199f102-aaaa-7000-c000-000000000001')).toBe(false);
  expect(isNewArticleId(`${ID}0`)).toBe(false);
});

it('[AC-F1-02w#15] field list keeps names and words first, prefixes body paths and dedupes', () => {
  expect(articleFieldList(['body'], [''])).toEqual(['body']);
  expect(
    articleFieldList(
      ['title', 'body', '全网最低'],
      ['content[0].marks[0].attrs.href', 'content[0]', 'content[0]'],
    ),
  ).toEqual([
    'title',
    'body',
    '全网最低',
    'body.content[0].marks[0].attrs.href',
    'body.content[0]',
  ]);
});

it('[AC-F1-02w#5] current version is the largest due published version, not the latest publish', () => {
  const now = new Date(NOW);
  const later = new Date(now.getTime() + 1);
  const rows = [
    row({ version: 4, status: 'published', published_at: now }),
    row({ version: 3, status: 'published', published_at: later }),
    row({ version: 2, status: 'offline', published_at: now }),
    row({ version: 1, status: 'published', published_at: new Date(now.getTime() - 9) }),
  ];
  expect(currentVersionOf(rows, now)?.version).toBe(4);
  expect(currentVersionOf(rows.slice(1), now)?.version).toBe(1);
  expect(currentVersionOf([rows[1]!], now)).toBeUndefined();
});

it('[AC-F1-02w#22] help_links exemption only when the entry points at this article', () => {
  expect(
    articleConfigKeysFor(ID, WORDS, {
      price_compare: { route: 'Help', params: { article_id: ID } },
    }),
  ).toEqual(['help_links.price_compare']);
  expect(
    articleConfigKeysFor(ID, WORDS, {
      price_compare: { route: 'Help', params: { article_id: 'x' } },
    }),
  ).toEqual([]);
  expect(articleConfigKeysFor(ID, WORDS, undefined)).toEqual([]);
  expect(articleConfigKeysFor(ID, WORDS, 'oops')).toEqual([]);
});

it('[AC-F1-02w#1] create inserts v1 draft at CAS 0 with normalised notice fields and one audit', async () => {
  const { store, state } = memory();
  const result = await admin(store).create(ACTOR, {
    article_id: ID,
    category: 'help',
    title: '使用帮助',
    body: doc('说明'),
    notice_closable: false,
    notice_end_at: '2026-11-01T00:00:00Z',
  });
  expect(result).toMatchObject({ article_id: ID, row_version: 0, current_version: null });
  expect(result.versions[0]).toMatchObject({
    version: 1,
    status: 'draft',
    notice_closable: true,
    notice_end_at: null,
    notice_content_version: 1,
    created_at: NOW,
  });
  expect(state.audits).toHaveLength(1);
  expect(state.audits[0]).toMatchObject({ action: 'article_create', target: ID, before: null });
  await expect(
    admin(store).create(ACTOR, { article_id: ID, category: 'help', title: 't', body: doc('x') }),
  ).rejects.toBeInstanceOf(ArticleConflictError);
  expect(state.rows).toHaveLength(1);
});

it('[AC-F1-02w#12] create checks the id, then category, before reading anything', async () => {
  const { store, state } = memory();
  expect(
    await fieldsOf(
      admin(store).create(ACTOR, {
        article_id: 'not-a-uuid',
        category: 'agreement',
        title: '全网最低',
        body: '{',
      }),
    ),
  ).toEqual(['article_id']);
  expect(
    await fieldsOf(
      admin(store).create(ACTOR, { article_id: ID, category: 'agreement', title: 't', body: '{' }),
    ),
  ).toEqual(['category']);
  expect(state.events).toEqual([]);
});

it('[AC-F1-02w#16] a missing union_host switch blocks union links; only boolean false admits', async () => {
  const href = 'https://union.example.test/a';
  const input = { article_id: ID, category: 'help' as const, title: '说明', body: doc('x', href) };
  for (const value of [undefined, true, 'false', 0]) {
    const { store } = memory([], { 'external_page.union_host_block': value });
    expect(await fieldsOf(admin(store).create(ACTOR, input))).toEqual([
      'body',
      'body.content[0].content[0].marks[0].attrs.href',
    ]);
  }
  const { store } = memory([], { 'external_page.union_host_block': false });
  expect((await admin(store).create(ACTOR, input)).versions).toHaveLength(1);
});

it('[AC-F1-02w#35] images need MEDIA_PUBLIC_BASE_URL; unset means no host is allowed', async () => {
  const image = JSON.stringify({
    type: 'doc',
    content: [{ type: 'image', attrs: { src: 'https://media.example.test/a.png' } }],
  });
  const input = { article_id: ID, category: 'help' as const, title: '说明', body: image };
  expect(await fieldsOf(admin(memory().store).create(ACTOR, input))).toEqual([
    'body',
    'body.content[0].attrs.src',
  ]);
  const ok = await admin(memory().store, undefined, 'https://media.example.test/assets').create(
    ACTOR,
    input,
  );
  expect(ok.versions[0]!.body).toBe(image);
});

it('[AC-F1-02w#2] save inserts newest + 1 after checks; checks run before the CAS', async () => {
  const { store, state } = memory([row()]);
  expect(
    await fieldsOf(
      admin(store).save(ACTOR, ID, { title: '全网最低', body: doc('x'), expected_row_version: 9 }),
    ),
  ).toEqual(['title', '全网最低']);
  await expect(
    admin(store).save(ACTOR, ID, { title: '第二版', body: doc('x'), expected_row_version: 9 }),
  ).rejects.toBeInstanceOf(ArticleConflictError);
  const result = await admin(store).save(ACTOR, ID, {
    title: '第二版',
    body: doc('x'),
    expected_row_version: 0,
  });
  expect(result.row_version).toBe(1);
  expect(result.versions.map((v) => [v.version, v.status])).toEqual([
    [2, 'draft'],
    [1, 'draft'],
  ]);
  expect(state.rows.find((r) => r.version === 1)).toEqual(row());
  expect(state.audits.map((a) => a.action)).toEqual(['article_draft_save']);
});

it('[AC-F1-02w#29] non-canonical or missing ids are 30701; agreement articles are read-only', async () => {
  const { store } = memory([row({ category: 'agreement' })]);
  await expect(admin(store).detail(APP, ID.toUpperCase())).rejects.toBeInstanceOf(
    ArticleNotFoundError,
  );
  await expect(
    admin(store).offline(ACTOR, '0199f102-aaaa-7000-8000-ffffffffffff', {
      expected_row_version: 0,
    }),
  ).rejects.toBeInstanceOf(ArticleNotFoundError);
  await expect(admin(store).detail('other_app', ID)).rejects.toBeInstanceOf(ArticleNotFoundError);
  expect(
    await fieldsOf(admin(store).publish(ACTOR, ID, { version: 1, expected_row_version: 99 })),
  ).toEqual(['category']);
});

it('[AC-F1-02w#4] publish: CAS, then newest draft, then published_at, then save checks', async () => {
  const { store, state } = memory([
    row({ version: 1, title: '全网最低' }),
    row({ version: 2, row_version: 1, body: doc('x', 'https://union.example.test/a') }),
  ]);
  const clock = new FixedClock(NOW);
  const a = admin(store, clock);
  await expect(
    a.publish(ACTOR, ID, { version: 1, expected_row_version: 0 }),
  ).rejects.toBeInstanceOf(ArticleConflictError);
  expect(await fieldsOf(a.publish(ACTOR, ID, { version: 1, expected_row_version: 1 }))).toEqual([
    'version',
  ]);
  expect(
    await fieldsOf(
      a.publish(ACTOR, ID, {
        version: 2,
        expected_row_version: 1,
        published_at: '2026-10-09T01:59:59.999Z',
      }),
    ),
  ).toEqual(['published_at']);
  expect(await fieldsOf(a.publish(ACTOR, ID, { version: 2, expected_row_version: 1 }))).toEqual([
    'body',
    'body.content[0].content[0].marks[0].attrs.href',
  ]);
  expect(state.audits).toEqual([]);
});

it('[AC-F1-02w#5] scheduled publish keeps the older published row and counts once due', async () => {
  const { store, state } = memory([row({ status: 'published', published_at: new Date(NOW) })]);
  const clock = new FixedClock(NOW);
  const a = admin(store, clock);
  await a.save(ACTOR, ID, { title: '第二版', body: doc('x'), expected_row_version: 0 });
  const due = '2026-10-09T03:00:00.000Z';
  const result = await a.publish(ACTOR, ID, {
    version: 2,
    expected_row_version: 1,
    published_at: due,
  });
  expect(result).toMatchObject({ row_version: 2, current_version: 1 });
  expect(state.rows.find((r) => r.version === 1)!.status).toBe('published');
  expect(state.audits.at(-1)).toMatchObject({
    action: 'article_publish',
    before: { version: 2, status: 'draft', row_version: 1, published_at: null },
    after: { version: 2, status: 'published', row_version: 2, published_at: due },
  });
  clock.set(due);
  expect((await a.detail(APP, ID)).current_version).toBe(2);
});

it('[AC-F1-02w#8] offline: every published row, notice end only when empty or later, drafts kept', async () => {
  const now = new Date(NOW);
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);
  const { store, state } = memory([
    row({
      category: 'notice',
      version: 1,
      status: 'published',
      published_at: future,
      row_version: 1,
    }),
    row({
      category: 'notice',
      version: 2,
      status: 'published',
      published_at: past,
      notice_end_at: past,
      row_version: 2,
    }),
    row({ category: 'notice', version: 3, notice_end_at: future, row_version: 3 }),
  ]);
  const a = admin(store);
  expect(
    await fieldsOf(
      a
        .offline(ACTOR, ID, { expected_row_version: 3 })
        .then(() => a.offline(ACTOR, ID, { expected_row_version: 4 })),
    ),
  ).toEqual(['article_id']);
  const byVersion = (v: number) => state.rows.find((r) => r.version === v)!;
  expect(byVersion(1)).toMatchObject({ status: 'offline', notice_end_at: now, row_version: 1 });
  expect(byVersion(2)).toMatchObject({ status: 'offline', notice_end_at: past, row_version: 2 });
  expect(byVersion(3)).toMatchObject({ status: 'draft', notice_end_at: future, row_version: 4 });
  expect(state.audits).toHaveLength(1);
  expect(JSON.stringify(state.audits[0]!.after)).toContain('"row_version":4');
  expect(JSON.stringify(state.audits[0])).not.toContain('"body"');
});

it('[AC-F1-02w#10] notice content version follows the newest row', async () => {
  const { store } = memory([row({ category: 'notice', notice_content_version: 3 })]);
  const a = admin(store);
  const same = await a.save(ACTOR, ID, {
    title: '使用帮助',
    body: doc('改正文'),
    notice_end_at: '2026-11-01T00:00:00Z',
    expected_row_version: 0,
  });
  expect(same.versions[0]!.notice_content_version).toBe(3);
  const changed = await a.save(ACTOR, ID, {
    title: '新标题',
    body: doc('x'),
    expected_row_version: 1,
  });
  expect(changed.versions[0]!.notice_content_version).toBe(4);
});

it('[AC-F1-02w#28] a primary key race on insert maps to 20902', async () => {
  const { store } = memory();
  const racing: ArticleAdminStore = {
    ...store,
    transaction: (work) =>
      store.transaction((tx) =>
        work({
          ...tx,
          taken: async () => false,
          insert: async () => {
            throw Object.assign(new Error('dup'), { code: '23505', constraint: 'articles_pkey' });
          },
        }),
      ),
  };
  await expect(
    admin(racing).create(ACTOR, { article_id: ID, category: 'help', title: 't', body: doc('x') }),
  ).rejects.toBeInstanceOf(ArticleConflictError);
});

it('[AC-F1-02zs#10] help_section goes after the named fields and before the words', () => {
  expect(withHelpSectionField([])).toEqual(['help_section']);
  expect(withHelpSectionField(['title', 'notice_end_at', '全网最低'])).toEqual([
    'title',
    'notice_end_at',
    'help_section',
    '全网最低',
  ]);
  expect(withHelpSectionField(['title', 'body', 'notice_end_at'])).toEqual([
    'title',
    'body',
    'notice_end_at',
    'help_section',
  ]);
  expect(withHelpSectionField(['body', '全网最低'])).toEqual(['body', 'help_section', '全网最低']);
  expect(helpSectionRejected('help', 'invite')).toBe(false);
  expect(helpSectionRejected('rule', null)).toBe(false);
  expect(helpSectionRejected('rule', 'invite')).toBe(true);
  expect(helpSectionRejected('notice', 'invite')).toBe(true);
});

it('[AC-F1-02zs#7] create and save store help_section; omitted clears it; audits carry it', async () => {
  const { store, state } = memory();
  const a = admin(store);
  const created = await a.create(ACTOR, {
    article_id: ID,
    category: 'help',
    title: '帮助',
    body: doc('x'),
    help_section: 'invite',
  });
  expect(created.versions[0]).toHaveProperty('help_section', 'invite');
  expect(state.rows[0]!.help_section).toBe('invite');
  expect(state.audits[0]).toMatchObject({ after: { help_section: 'invite' } });
  const saved = await a.save(ACTOR, ID, { title: '帮助', body: doc('y'), expected_row_version: 0 });
  expect(saved.versions[0]).not.toHaveProperty('help_section');
  expect(saved.versions[1]).toHaveProperty('help_section', 'invite');
  expect(state.rows.find((r) => r.version === 2)!.help_section).toBeNull();
  expect(state.audits[1]).toMatchObject({
    before: { help_section: 'invite' },
    after: { help_section: null },
  });
});

it('[AC-F1-02zs#9] help_section on another category is 20001 with nothing written', async () => {
  const { store, state } = memory([row({ category: 'rule' })]);
  const a = admin(store);
  expect(
    await fieldsOf(
      a.create(ACTOR, {
        article_id: '0199f102-aaaa-7000-8000-000000000002',
        category: 'notice',
        title: '全网最低',
        body: doc('x'),
        notice_closable: false,
        help_section: 'invite',
      }),
    ),
  ).toEqual(['title', 'notice_end_at', 'help_section', '全网最低']);
  expect(
    await fieldsOf(
      a.save(ACTOR, ID, {
        title: '规则',
        body: doc('x'),
        help_section: 'withdraw',
        expected_row_version: 0,
      }),
    ),
  ).toEqual(['help_section']);
  expect(state.rows).toHaveLength(1);
  expect(state.audits).toEqual([]);
});

it('[AC-F1-02zs#11] views show help_section only when set; publish audit keeps it', async () => {
  const now = new Date(NOW);
  const view = articleView([row({ version: 2, help_section: 'withdraw' }), row()], now);
  expect(view.versions[0]).toHaveProperty('help_section', 'withdraw');
  expect(view.versions[1]).not.toHaveProperty('help_section');
  const { store, state } = memory([row({ help_section: 'invite' })]);
  const published = await admin(store).publish(ACTOR, ID, { version: 1, expected_row_version: 0 });
  expect(published.versions[0]).toHaveProperty('help_section', 'invite');
  expect(state.audits[0]).toMatchObject({
    action: 'article_publish',
    before: { help_section: 'invite' },
    after: { help_section: 'invite' },
  });
});
