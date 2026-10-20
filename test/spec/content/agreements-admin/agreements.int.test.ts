import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  BODY,
  H5,
  NOW,
  config,
  detail,
  factory,
  input,
  list,
  member,
  publish,
  publishOk,
  request,
  rejected,
  setup,
  snapshot,
  stepUp,
  success,
  useHarness,
  type Detail,
  type Page,
  type Version,
} from './kit.ts';
import { faultAt, orderedRace } from './transactions.ts';

// 只替换尚无真实资料的联盟域名表（specs/link-patterns.yaml 待 B1-07），用合成表；其余保存、发布、Clock、DB、守卫皆真实。
vi.mock('../../../../apps/api/src/modules/platform/specs/link-patterns.ts', () => ({
  getLinkPatterns: () => ({
    version: 'synthetic',
    rules: [
      { platform: 'taobao', category: 'union_host', hosts: ['item.taobao.com'], path_patterns: [] },
    ],
  }),
}));

// 审计行的 bigint id 由驱动读成 BigInt；序列化时转字符串，只为检查内容。
const json = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02p#1] all three routes require content.agreement, even with valid totp', async () => {
  const f = await setup(h);
  await publishOk(f);
  const caller = await member(h, f, ['content.article']);
  const denied = { ...f, ...caller };
  const token = await stepUp(f, caller);
  const before = await snapshot(h, f.appId);
  await rejected(await list(denied), 'list', 10403, { reason: 'admin_permission_denied' });
  await rejected(await detail(denied, 'privacy', 1), 'detail', 10403, {
    reason: 'admin_permission_denied',
  });
  await rejected(
    await publish(denied, 'privacy', input({ expected_version: 1 }), token),
    'publish',
    10403,
    { reason: 'admin_permission_denied' },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#2] an ordinary permitted admin reads without step-up but cannot publish without totp', async () => {
  const f = await setup(h);
  await publishOk(f);
  const caller = await member(h, f, ['content.agreement']);
  const allowed = { ...f, ...caller };
  const before = await snapshot(h, f.appId);
  expect((await success<Page>(await list(allowed), 'list')).total).toBe(1);
  expect((await success<Detail>(await detail(allowed, 'privacy', 1), 'detail')).body).toBe(BODY);
  await rejected(
    await publish(allowed, 'privacy', input({ expected_version: 1 })),
    'publish',
    10003,
    { tier: 'totp' },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#3] first privacy publish atomically stores exact text, version, legal configs and audit using Clock', async () => {
  const f = await setup(h);
  const caller = await member(h, f, ['content.agreement']);
  const token = await stepUp(f, caller);
  const at = f.clock.now();
  const before = await snapshot(h, f.appId);
  const body = input();
  const row = await success<Version>(
    await publish({ ...f, ...caller }, 'privacy', body, token),
    'publish',
  );
  const digest = createHash('sha256').update(BODY, 'utf8').digest('hex');
  expect(row).toMatchObject({
    type: 'privacy',
    version: 1,
    min_version: 1,
    requires_resign: false,
    article_version: 1,
    text_sha256: digest,
    legal_confirmed_by: body.legal_confirmed_by,
    legal_confirm_note: body.legal_confirm_note,
    published_by: caller.actor.id,
  });
  expect(row.article_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(new Date(row.published_at)).toEqual(at);
  expect(row.url.startsWith(H5)).toBe(true);
  expect(row.url).toContain('type=privacy&version=1');
  const after = await snapshot(h, f.appId);
  expect(after.articles).toEqual([
    expect.objectContaining({
      id: row.article_id,
      app_id: f.appId,
      version: 1,
      row_version: 0,
      title: body.title,
      body: BODY,
      category: 'agreement',
      status: 'published',
      notice_closable: false,
      notice_end_at: null,
      published_at: at,
      created_at: at,
      updated_at: at,
    }),
  ]);
  expect(after.agreements).toEqual([
    expect.objectContaining({
      app_id: f.appId,
      type: 'privacy',
      version: 1,
      article_id: row.article_id,
      article_version: 1,
      text_sha256: digest,
      url: row.url,
      min_version: 1,
      requires_resign: false,
      legal_confirmed_by: body.legal_confirmed_by,
      legal_confirm_note: body.legal_confirm_note,
      published_by: caller.actor.id,
      published_at: at,
      created_at: at,
    }),
  ]);
  expect(after.items.filter((r) => r.key.startsWith('legal.'))).toEqual(
    ['legal.privacy.min_version', 'legal.privacy.version'].map((key) =>
      expect.objectContaining({
        key,
        value: 1,
        version: 1,
        row_version: 0,
        updated_by: caller.actor.username,
        created_at: at,
        updated_at: at,
      }),
    ),
  );
  expect(after.versions).toEqual(
    ['legal.privacy.min_version', 'legal.privacy.version'].map((key) =>
      expect.objectContaining({
        key,
        version: 1,
        value: 1,
        updated_by: caller.actor.username,
        updated_by_admin_id: caller.actor.id,
        reason: 'agreement_publish',
        created_at: at,
      }),
    ),
  );
  const added = after.audits.filter((r) => !before.audits.some((old) => old.id === r.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    action: 'agreement_publish',
    app_id: f.appId,
    admin_id: caller.actor.id,
    at,
    before: null,
    after: {
      type: 'privacy',
      version: 1,
      min_version: 1,
      requires_resign: false,
      article_id: row.article_id,
      article_version: 1,
      text_sha256: digest,
      legal_confirmed_by: body.legal_confirmed_by,
      legal_confirmed_on: body.legal_confirmed_on,
    },
  });
  expect(json(added)).not.toContain('"body"');
  expect(json(added)).not.toContain('协议原文');
});

it('[AC-F1-02p#4] second version appends to the same article, advances config history and keeps old text readable', async () => {
  const f = await setup(h);
  const first = await publishOk(f);
  const before = await snapshot(h, f.appId);
  const nextBody = input({
    expected_version: 1,
    min_version: 2,
    body: BODY.replace('协议原文', '第二版原文'),
  });
  const second = await publishOk(f, 'privacy', nextBody);
  expect(second).toMatchObject({
    version: 2,
    article_id: first.article_id,
    article_version: 2,
    min_version: 2,
  });
  const after = await snapshot(h, f.appId);
  expect(after.articles[0]).toEqual(before.articles[0]);
  expect(after.agreements[0]).toEqual(before.agreements[0]);
  expect(after.articles[1]).toMatchObject({
    row_version: 1,
    version: 2,
    body: nextBody.body,
    published_at: f.clock.now(),
  });
  for (const key of ['legal.privacy.version', 'legal.privacy.min_version']) {
    expect(after.items.find((r) => r.key === key)).toMatchObject({
      version: 2,
      row_version: 1,
      value: 2,
      updated_by: f.actor.username,
      updated_at: f.clock.now(),
    });
    expect(after.versions.filter((r) => r.key === key).map((r) => [r.version, r.value])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  }
  const audits = after.audits.filter((r) => r.action === 'agreement_publish');
  expect(audits).toHaveLength(2);
  expect(audits[1]).toMatchObject({
    before: { version: 1, min_version: 1, requires_resign: false },
    after: {
      version: 2,
      min_version: 2,
      requires_resign: false,
      legal_confirmed_on: nextBody.legal_confirmed_on,
    },
  });
  expect(json(audits)).not.toContain('"body"');
  const api = await (await factory())('api', f.overrides);
  h.apps.push(api);
  await api.init();
  for (const [version, body] of [
    [1, BODY],
    [2, nextBody.body],
  ] as const) {
    const trace = randomUUID();
    const response = await api.inject({
      method: 'GET',
      url: `/v1/articles/${first.article_id}?version=${version}`,
      headers: {
        'x-trace-id': trace,
        'x-app-id': f.appId,
        'x-platform': 'ios',
        'x-app-version': '2.0.0',
      },
    });
    expect(await success({ response, trace }, 'article')).toMatchObject({
      article_id: first.article_id,
      version,
      body,
    });
    expect(await success<Detail>(await detail(f, 'privacy', version), 'detail')).toMatchObject({
      title: nextBody.title,
      body,
    });
  }
});

it('[AC-F1-02p#5] a successful publish consumes the step-up token', async () => {
  const f = await setup(h);
  const token = await stepUp(f);
  await success(await publish(f, 'privacy', input(), token), 'publish');
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1_000);
  await rejected(
    await publish(f, 'privacy', input({ expected_version: 1 }), token),
    'publish',
    10003,
    { tier: 'totp' },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#6] stale expected_version returns agreement conflict before writing any row', async () => {
  const f = await setup(h);
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  await rejected(
    await publish(f, 'privacy', input({ expected_version: 1 }), token),
    'publish',
    20902,
    { resource: 'agreement' },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

for (const current of [0, 1]) {
  it(`[AC-F1-02p#7] same expected version has exactly one winner, current=${current}`, async () => {
    const f = await setup(h);
    if (current === 1) await publishOk(f);
    const firstCaller = await member(h, f, ['content.agreement']);
    const secondCaller = await member(h, f, ['content.agreement']);
    const firstToken = await stepUp(f, firstCaller);
    const secondToken = await stepUp(f, secondCaller);
    const before = await snapshot(h, f.appId);
    const result = await orderedRace(
      h,
      f,
      { caller: firstCaller, step: firstToken },
      { caller: secondCaller, step: secondToken },
      input({ expected_version: current }),
    );
    await success(result.second, 'publish');
    await rejected(result.first, 'publish', 20902, { resource: 'agreement' });
    const after = await snapshot(h, f.appId);
    expect(after.agreements).toHaveLength(before.agreements.length + 1);
    expect(after.articles).toHaveLength(before.articles.length + 1);
    expect(after.versions).toHaveLength(before.versions.length + 2);
    expect(after.audits.filter((r) => r.action === 'agreement_publish')).toHaveLength(current + 1);
    expect(after.items.find((r) => r.key === 'legal.privacy.version')?.value).toBe(current + 1);
  });
}

const invalid = [
  { label: 'minimum above new version', patch: { min_version: 2 }, fields: ['min_version'] },
  {
    label: 'privacy cannot require signing',
    patch: { requires_resign: true },
    fields: ['requires_resign'],
  },
  { label: 'tab confirmer', patch: { legal_confirmed_by: '\t' }, fields: ['legal_confirmed_by'] },
  {
    label: 'fullwidth space confirmer',
    patch: { legal_confirmed_by: '\u3000' },
    fields: ['legal_confirmed_by'],
  },
  {
    label: 'blank confirmation note',
    patch: { legal_confirm_note: '\t\u3000' },
    fields: ['legal_confirm_note'],
  },
  {
    label: 'impossible date',
    patch: { legal_confirmed_on: '2026-02-30' },
    fields: ['legal_confirmed_on'],
  },
  {
    label: 'date with newline',
    patch: { legal_confirmed_on: '2026-10-18\n' },
    fields: ['legal_confirmed_on'],
  },
  { label: 'blank title', patch: { title: '\t' }, fields: ['title'] },
] as const;
for (const test of invalid) {
  it(`[AC-F1-02p#8] ${test.label} returns fields and leaves all five tables unchanged`, async () => {
    const f = await setup(h);
    const token = await stepUp(f);
    const before = await snapshot(h, f.appId);
    await rejected(await publish(f, 'privacy', input(test.patch), token), 'publish', 20001, {
      fields: [...test.fields],
    });
    expect(await snapshot(h, f.appId)).toEqual(before);
  });
}

it('[AC-F1-02p#9] min_version cannot drop below the previous minimum even when below the new version', async () => {
  const f = await setup(h);
  await publishOk(f);
  await publishOk(f, 'privacy', { expected_version: 1, min_version: 2 });
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  await rejected(
    await publish(f, 'privacy', input({ expected_version: 2, min_version: 1 }), token),
    'publish',
    20001,
    { fields: ['min_version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#10] first labor version must require signing', async () => {
  const f = await setup(h);
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  await rejected(await publish(f, 'labor_agreement', input(), token), 'publish', 20001, {
    fields: ['requires_resign'],
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

const linkBody = (href: string) =>
  JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href } }] }],
      },
    ],
  });
const imageBody = (src: string) =>
  JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src } }] });
for (const [label, body] of [
  ['iframe', '{"type":"doc","content":[{"type":"iframe"}]}'],
  ['union link', linkBody('https://item.taobao.com/item.htm?id=123')],
  ['untrusted image', imageBody('https://other.example.test/image.png')],
] as const) {
  it(`[AC-F1-02p#11] rejects ${label} in body without partial writes`, async () => {
    const f = await setup(h);
    const token = await stepUp(f);
    const before = await snapshot(h, f.appId);
    const sent = await publish(f, 'privacy', input({ body }), token);
    await rejected(sent, 'publish', 20001);
    expect(sent.response.json().data.fields).toEqual(expect.arrayContaining(['body']));
    expect(await snapshot(h, f.appId)).toEqual(before);
  });
}

it('[AC-F1-02p#12] combines and deduplicates invalid fields before body paths', async () => {
  const f = await setup(h);
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  const sent = await publish(
    f,
    'privacy',
    input({
      min_version: 2,
      legal_confirmed_by: '\t',
      title: '\t',
      body: linkBody('https://item.taobao.com/item.htm?id=123'),
    }),
    token,
  );
  await rejected(sent, 'publish', 20001);
  const fields = sent.response.json<{ data: { fields: string[] } }>().data.fields;
  expect(fields).toHaveLength(5);
  expect(new Set(fields.slice(0, 4))).toEqual(
    new Set(['body', 'legal_confirmed_by', 'min_version', 'title']),
  );
  expect(fields.slice(4)).toEqual(['content[0].content[0].marks[0].attrs.href']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#13] media host is taken from APP_CONFIG and the union block switch is read freshly', async () => {
  const f = await setup(h);
  await publishOk(f, 'privacy', { body: imageBody('https://media.example.test/assets/image.png') });
  await config(h, f.appId, 'external_page.union_host_block', false);
  const body = linkBody('https://item.taobao.com/item.htm?id=123');
  expect(await publishOk(f, 'privacy', { expected_version: 1, body })).toMatchObject({
    version: 2,
  });
  f.clock.advanceMs(1_000);
  await h.db
    .updateTable('config_items')
    .set({ value: true, updated_at: f.clock.now() })
    .where('app_id', '=', f.appId)
    .where('key', '=', 'external_page.union_host_block')
    .execute();
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  const sent = await publish(f, 'privacy', input({ expected_version: 2, body }), token);
  await rejected(sent, 'publish', 20001);
  expect(sent.response.json().data.fields).toEqual(expect.arrayContaining(['body']));
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#14] missing H5 base fails closed without any writes', async () => {
  const f = await setup(h, { h5: false });
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  await rejected(await publish(f, 'privacy', input(), token), 'publish', 50001);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#15] agreement changes only its legal version; labor changes no legal config', async () => {
  const f = await setup(h);
  await config(h, f.appId, 'legal.privacy.version', 7);
  await config(h, f.appId, 'legal.privacy.min_version', 3);
  await config(h, f.appId, 'unrelated.config', 'preserve');
  const before = await snapshot(h, f.appId);
  await publishOk(f, 'agreement');
  const afterAgreement = await snapshot(h, f.appId);
  // F1-02zzc (test-change, transitional; F1-02zt tightens): publishing the user agreement may also
  // write legal.agreement.min_version in the same transaction (docs/changes/20261020 §1.12). The
  // branch is chosen by whether that row exists after publishing; each branch is asserted strictly.
  const minRow = afterAgreement.items.find((r) => r.key === 'legal.agreement.min_version');
  if (minRow === undefined) {
    expect(afterAgreement.items.filter((r) => r.key !== 'legal.agreement.version')).toEqual(
      before.items,
    );
    expect(afterAgreement.items.find((r) => r.key === 'legal.agreement.version')).toMatchObject({
      value: 1,
      version: 1,
    });
    expect(afterAgreement.versions.map((r) => r.key)).toEqual(['legal.agreement.version']);
  } else {
    expect(
      afterAgreement.items.filter(
        (r) => r.key !== 'legal.agreement.version' && r.key !== 'legal.agreement.min_version',
      ),
    ).toEqual(before.items);
    expect(afterAgreement.items.find((r) => r.key === 'legal.agreement.version')).toMatchObject({
      value: 1,
      version: 1,
    });
    // input() requests min_version 1.
    expect(minRow).toMatchObject({ value: 1, version: 1 });
    expect(afterAgreement.versions.map((r) => r.key)).toEqual([
      'legal.agreement.min_version',
      'legal.agreement.version',
    ]);
    expect(afterAgreement.versions.map((r) => [r.key, r.version, r.value])).toEqual([
      ['legal.agreement.min_version', 1, 1],
      ['legal.agreement.version', 1, 1],
    ]);
  }
  await publishOk(f, 'labor_agreement', { requires_resign: true });
  const afterLabor = await snapshot(h, f.appId);
  expect(afterLabor.items).toEqual(afterAgreement.items);
  expect(afterLabor.versions).toEqual(afterAgreement.versions);
});

for (const type of ['privacy', 'agreement'] as const) {
  for (const value of [1, 5]) {
    it(`[AC-F1-02p#16] preset legal ${type} version ${value} cannot be silently kept or downgraded`, async () => {
      const f = await setup(h);
      await config(h, f.appId, `legal.${type}.version`, value);
      const token = await stepUp(f);
      const before = await snapshot(h, f.appId);
      const logStart = f.lines.length;
      // F1-02zf (test-change): the orchestrator ruled (L44, 2026-10-19 22:2x) that a preset version
      // at or above the new one is a business conflict answering 20902 data.resource=agreement with a
      // warn log; F1-02za's transitional 50001 branch is removed now that F1-02z (#931) has landed.
      const sent = await publish(f, type, input(), token);
      await rejected(sent, 'publish', 20902, { resource: 'agreement' });
      expect(await snapshot(h, f.appId)).toEqual(before);
      expect(
        f.lines
          .slice(logStart)
          .map((line) => JSON.parse(line) as { level: number })
          .some((line) => line.level >= 50),
      ).toBe(false);
    });
  }
}

it('[AC-F1-02p#17] existing config revisions advance independently of agreement versions', async () => {
  const f = await setup(h);
  await publishOk(f);
  // Simulate intervening config revisions while retaining valid, positive legal values.
  for (const [key, version, rowVersion] of [
    ['legal.privacy.version', 7, 11],
    ['legal.privacy.min_version', 9, 15],
  ] as const) {
    f.clock.advanceMs(1_000);
    await h.db
      .updateTable('config_items')
      .set({ version, row_version: rowVersion, updated_at: f.clock.now() })
      .where('app_id', '=', f.appId)
      .where('key', '=', key)
      .execute();
  }
  await publishOk(f, 'privacy', { expected_version: 1, min_version: 2 });
  const after = await snapshot(h, f.appId);
  expect(after.items.find((r) => r.key === 'legal.privacy.version')).toMatchObject({
    value: 2,
    version: 8,
    row_version: 12,
    updated_by: f.actor.username,
  });
  expect(after.items.find((r) => r.key === 'legal.privacy.min_version')).toMatchObject({
    value: 2,
    version: 10,
    row_version: 16,
  });
  expect(after.versions.filter((row) => row.version > 1)).toEqual([
    expect.objectContaining({
      key: 'legal.privacy.min_version',
      version: 10,
      value: 2,
      updated_by_admin_id: f.actor.id,
      reason: 'agreement_publish',
    }),
    expect.objectContaining({
      key: 'legal.privacy.version',
      version: 8,
      value: 2,
      updated_by_admin_id: f.actor.id,
      reason: 'agreement_publish',
    }),
  ]);
});

it('[AC-F1-02p#18] list paginates newest first, filters by type, omits body, and isolates app_id', async () => {
  const f = await setup(h);
  const first = await publishOk(f);
  await publishOk(f, 'agreement');
  const last = await publishOk(f, 'privacy', { expected_version: 1 });
  const other = await setup(h);
  await publishOk(other, 'labor_agreement', { requires_resign: true });
  const p1 = await success<Page>(await list(f, '?page=1&page_size=2'), 'list');
  const p2 = await success<Page>(await list(f, '?page=2&page_size=2'), 'list');
  expect(p1).toMatchObject({ page: 1, page_size: 2, total: 3 });
  expect(p2).toMatchObject({ page: 2, page_size: 2, total: 3 });
  expect([...p1.items, ...p2.items].map((r) => [r.type, r.version])).toEqual([
    ['privacy', 2],
    ['agreement', 1],
    ['privacy', 1],
  ]);
  for (const row of [...p1.items, ...p2.items]) {
    expect(row).not.toHaveProperty('body');
    expect(row.published_by).toBe(f.actor.id);
  }
  const filtered = await success<Page>(await list(f, '?type=privacy&page=1&page_size=1'), 'list');
  expect(filtered).toMatchObject({ total: 2, items: [last] });
  expect(await success<Detail>(await detail(f, 'privacy', 1), 'detail')).toEqual({
    ...first,
    title: input().title,
    body: BODY,
  });
  await rejected(await detail(f, 'privacy', 99), 'detail', 30701);
  await rejected(await detail(f, 'labor_agreement', 1), 'detail', 30701);
  await rejected(await detail(other, 'privacy', 1), 'detail', 30701);
});

it('[AC-F1-02p#19] equal publication times use version descending as the tie-breaker', async () => {
  const f = await setup(h);
  await publishOk(f);
  const existing = (await snapshot(h, f.appId)).agreements[0]!;
  f.clock.advanceMs(1_000);
  // Insert a valid historical tie without changing the insert-only published row.
  await h.db
    .insertInto('agreements')
    .values({
      ...existing,
      id: randomUUID(),
      version: 2,
      url: `${H5}?type=privacy&version=2`,
      created_at: f.clock.now(),
    })
    .execute();
  const page = await success<Page>(await list(f), 'list');
  expect(page.items.map((row) => row.version)).toEqual([2, 1]);
  expect(page.items[0]!.published_at).toBe(page.items[1]!.published_at);
});

it('[AC-F1-02p#20] a previous agreement pointing to another app article fails closed', async () => {
  const f = await setup(h);
  const other = await setup(h);
  const foreign = await publishOk(other);
  await h.db
    .insertInto('agreements')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      type: 'privacy',
      version: 1,
      min_version: 1,
      requires_resign: false,
      article_id: foreign.article_id,
      article_version: 1,
      text_sha256: '0'.repeat(64),
      url: `${H5}?type=privacy&version=1`,
      legal_confirmed_by: 'fixture',
      legal_confirm_note: 'fixture',
      published_at: NOW,
      published_by: f.actor.id,
      created_at: NOW,
    })
    .execute();
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  const foreignBefore = await snapshot(h, other.appId);
  await rejected(
    await publish(f, 'privacy', input({ expected_version: 1 }), token),
    'publish',
    50001,
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await snapshot(h, other.appId)).toEqual(foreignBefore);
});

for (const target of ['agreements', 'config_item_versions', 'audit_logs'] as const) {
  it(`[AC-F1-02p#21] failure inserting ${target} rolls back articles, agreements, configs, history and audit`, async () => {
    const f = await setup(h);
    // Existing config rows detect nontransactional UPDATE as well as orphan INSERT.
    await config(h, f.appId, 'legal.privacy.min_version', 1, 4, 2);
    const token = await stepUp(f);
    const before = await snapshot(h, f.appId);
    const sent = await faultAt(h, f, target, token);
    await rejected(
      sent,
      'publish',
      target === 'agreements' ? 20902 : 50001,
      target === 'agreements' ? { resource: 'agreement' } : undefined,
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  });
}

it('[AC-F1-02p#22] article revision uses the maximum stored revision and its row_version', async () => {
  const f = await setup(h);
  const first = await publishOk(f);
  const existing = (await snapshot(h, f.appId)).articles[0]!;
  f.clock.advanceMs(1_000);
  await h.db
    .insertInto('articles')
    .values({
      ...existing,
      version: 7,
      row_version: 12,
      status: 'draft',
      published_at: null,
      body: BODY.replace('协议原文', '独立文章修订'),
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  const before = await snapshot(h, f.appId);
  const next = await publishOk(f, 'privacy', { expected_version: 1 });
  expect(next).toMatchObject({ version: 2, article_id: first.article_id, article_version: 8 });
  const after = await snapshot(h, f.appId);
  expect(after.articles.slice(0, 2)).toEqual(before.articles);
  expect(after.articles[2]).toMatchObject({ version: 8, row_version: 13, body: BODY });
  expect(after.agreements[1]).toMatchObject({ article_version: 8, version: 2 });
});

it('[AC-F1-02p#23] labor can retain the minimum without resigning, then raise it with resigning', async () => {
  const f = await setup(h);
  const first = await publishOk(f, 'labor_agreement', { requires_resign: true });
  const second = await publishOk(f, 'labor_agreement', {
    expected_version: 1,
    requires_resign: false,
  });
  const third = await publishOk(f, 'labor_agreement', {
    expected_version: 2,
    min_version: 3,
    requires_resign: true,
  });
  expect(second).toMatchObject({
    article_id: first.article_id,
    version: 2,
    min_version: 1,
    requires_resign: false,
  });
  expect(third).toMatchObject({
    article_id: first.article_id,
    version: 3,
    min_version: 3,
    requires_resign: true,
  });
  const after = await snapshot(h, f.appId);
  expect(after.items.filter((row) => row.key.startsWith('legal.'))).toEqual([]);
  expect(after.versions).toEqual([]);
  expect(after.audits.filter((row) => row.action === 'agreement_publish').at(-1)).toMatchObject({
    before: { version: 2, min_version: 1, requires_resign: false },
    after: { version: 3, min_version: 3, requires_resign: true },
  });
});

it('[AC-F1-02p#24] reads do not consume a supplied token and a failed publish leaves it usable', async () => {
  const f = await setup(h);
  await publishOk(f);
  const token = await stepUp(f);
  await success(
    await request(f.app, f.token, 'GET', '/admin/v1/agreements', undefined, token),
    'list',
  );
  await success(
    await request(
      f.app,
      f.token,
      'GET',
      '/admin/v1/agreements/privacy/versions/1',
      undefined,
      token,
    ),
    'detail',
  );
  f.clock.advanceMs(1_000);
  const before = await snapshot(h, f.appId);
  await rejected(
    await publish(f, 'privacy', input({ expected_version: 1, min_version: 3 }), token),
    'publish',
    20001,
    { fields: ['min_version'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  f.clock.advanceMs(1_000);
  expect(
    await success<Version>(
      await publish(f, 'privacy', input({ expected_version: 1 }), token),
      'publish',
    ),
  ).toMatchObject({ version: 2 });
});

it('[AC-F1-02p#25] absent media base does not admit an arbitrary image host', async () => {
  const f = await setup(h, { media: false });
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  const sent = await publish(
    f,
    'privacy',
    input({ body: imageBody('https://media.example.test/assets/image.png') }),
    token,
  );
  await rejected(sent, 'publish', 20001);
  expect(sent.response.json().data.fields).toEqual(expect.arrayContaining(['body']));
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02p#26] agreement title and body allow article banned words and preserve the exact text', async () => {
  const f = await setup(h);
  const title = '原价说明';
  const body = BODY.replace('协议原文', '佣金、返现及结算中的约定');
  const row = await publishOk(f, 'labor_agreement', { title, body, requires_resign: true });
  const after = await snapshot(h, f.appId);
  expect(after.articles).toEqual([
    expect.objectContaining({ id: row.article_id, version: 1, title, body, status: 'published' }),
  ]);
  expect(after.agreements).toEqual([
    expect.objectContaining({
      type: 'labor_agreement',
      version: 1,
      article_id: row.article_id,
      article_version: 1,
      text_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    }),
  ]);
});

for (const patch of [
  { min_version: 1, requires_resign: true },
  { min_version: 2, requires_resign: false },
]) {
  it(`[AC-F1-02p#27] labor v2 rejects min_version=${patch.min_version}, requires_resign=${patch.requires_resign}`, async () => {
    const f = await setup(h);
    await publishOk(f, 'labor_agreement', { requires_resign: true });
    const token = await stepUp(f);
    const before = await snapshot(h, f.appId);
    await rejected(
      await publish(f, 'labor_agreement', input({ expected_version: 1, ...patch }), token),
      'publish',
      20001,
      { fields: ['requires_resign'] },
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  });
}

it('[AC-F1-02p#28] HTTP H5 base fails closed without any writes', async () => {
  const f = await setup(h, { h5: false });
  await config(h, f.appId, 'h5_base_url', 'http://h5.example.test/');
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  await rejected(await publish(f, 'privacy', input(), token), 'publish', 50001);
  expect(await snapshot(h, f.appId)).toEqual(before);
});
