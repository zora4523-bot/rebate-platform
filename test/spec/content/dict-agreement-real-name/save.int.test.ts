// D10-204 / BR-TEXT-14: run only in the orchestrator's isolated PG + Redis container.
// Reuse dict-admin's real token/session, HTTP contract checks and database snapshots. Only the
// default/spec data loaders are augmented; classification, authorization and writes stay real.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  harness,
  member,
  rejected,
  send,
  setup,
  snapshot,
  stepUp,
  success,
  type Harness,
  type Saved,
} from '../dict-admin/kit.ts';
import { CONSENT_DEFAULTS, CONSENT_KEYS } from './fixtures.ts';

vi.mock('../../../../apps/api/src/modules/content/infra/texts-default.ts', async (original) => {
  const actual =
    await original<
      typeof import('../../../../apps/api/src/modules/content/infra/texts-default.ts')
    >();
  return {
    ...actual,
    defaultTexts: () => ({ ...actual.defaultTexts(), ...CONSENT_DEFAULTS }),
  };
});
vi.mock('../../../../apps/api/src/modules/content/specs/text-specs.ts', async (original) => {
  const actual =
    await original<typeof import('../../../../apps/api/src/modules/content/specs/text-specs.ts')>();
  return {
    ...actual,
    getFundTermKeys: () => {
      const spec = actual.getFundTermKeys();
      return {
        ...spec,
        ordinary: { ...spec.ordinary, keys: [...spec.ordinary.keys, ...CONSENT_KEYS] },
      };
    },
  };
});

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  redis = await testing.acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

it.each(CONSENT_KEYS)(
  '[AC-F1-02zzi#2] 仅 config.general 保存 %s 被拒，不能靠填法务确认人或二次验证越权',
  async (key) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const body = { changes: [{ key, text: '测试修改文案' }], expected_version: '0' };
    rejected(await send(f, 'save', body), 10403, { reason: 'admin_permission_denied' });
    rejected(
      await send(
        f,
        'save',
        { ...body, legal_confirmed_by: '测试法务甲' },
        { stepUp: await stepUp(h, f.actor) },
      ),
      10403,
      { reason: 'admin_permission_denied' },
    );
    // Existing agreement refusal semantics: no publication, history or business audit;
    // dict_items_denied is exclusively the fund_terms refusal audit.
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02zzi#3] 同时有普通与协议权限仍须法务确认，缺失时原子拒绝且不写成功审计', async () => {
  const f = await setup(h);
  const actor = await member(h, f.appId, ['config.general', 'content.agreement']);
  const before = await snapshot(h, f.appId);
  rejected(
    await send(
      f,
      'save',
      {
        changes: CONSENT_KEYS.map((key) => ({ key, text: '测试修改文案' })),
        expected_version: '0',
      },
      { token: actor.token, stepUp: await stepUp(h, actor) },
    ),
    20001,
    { fields: ['legal_confirmed_by'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02zzi#4] 仅协议权限经 totp 和法务确认可保存实名同意书，发布与审计同事务落库', async () => {
  const f = await setup(h);
  const actor = await member(h, f.appId, ['content.agreement']);
  const changes = CONSENT_KEYS.map((key) => ({ key, text: '测试已确认文案' }));
  const body = { changes, expected_version: '0', legal_confirmed_by: '测试法务乙' };
  const before = await snapshot(h, f.appId);
  rejected(await send(f, 'save', body, { token: actor.token }), 10003, { tier: 'totp' });
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(
    success<Saved>(
      await send(f, 'save', body, { token: actor.token, stepUp: await stepUp(h, actor) }),
    ),
  ).toEqual({ version: '1', keys: CONSENT_KEYS });
  const saved = await snapshot(h, f.appId);
  expect(saved.items).toHaveLength(CONSENT_KEYS.length);
  for (const change of changes) {
    expect(saved.items).toContainEqual(
      expect.objectContaining({
        app_id: f.appId,
        dict: 'real_name',
        code: change.key.slice('real_name.'.length),
        text: change.text,
        version: 1,
        created_by: actor.id,
        created_at: h.clock.now(),
      }),
    );
  }
  expect(saved.config).toHaveLength(1);
  expect(saved.config[0]).toMatchObject({ value: '1', version: 1 });
  expect(saved.versions).toHaveLength(1);
  expect(saved.versions[0]).toMatchObject({ value: '1', updated_by_admin_id: actor.id });
  expect(saved.audits).toHaveLength(1);
  expect(saved.audits[0]).toMatchObject({
    app_id: f.appId,
    admin_id: actor.id,
    action: 'dict_items_save',
    target: 'dict_items',
    before: { dict_version: '0', items: CONSENT_KEYS.map((key) => ({ key, text: null })) },
    after: {
      dict_version: '1',
      items: changes,
      legal_confirmed_by: '测试法务乙',
      fund_terms: false,
    },
  });
});
