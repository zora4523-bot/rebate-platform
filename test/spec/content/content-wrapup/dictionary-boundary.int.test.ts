// F1-02z §9.2#3 / §9.3#5–6: reading int32 max must not relax the write parser.
import { randomUUID } from 'node:crypto';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { expect, it } from 'vitest';
import {
  config,
  factory,
  rejected,
  request,
  setup,
  success,
  useHarness,
  type Harness,
  type Setup,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));
const KEY = 'about.copy_diagnostics';
const MAX = 2_147_483_647;
const TEXT = '最大版本的诊断入口';

async function seedVersion(harness: Harness, f: Setup, value: string) {
  await config(harness, f.appId, 'dict_version', value);
  // Two revisions distinguish reading MAX from accidentally clamping to MAX - 1.
  await harness.db
    .insertInto('dict_items')
    .values(
      [1, MAX].map((version) => ({
        app_id: f.appId,
        dict: 'about',
        code: 'copy_diagnostics',
        version,
        text: version === MAX ? TEXT : '旧版诊断入口',
        created_by: f.actor.id,
        created_at: f.clock.now(),
      })),
    )
    .execute();
}

async function snapshot(appId: string) {
  return {
    items: await h.db
      .selectFrom('dict_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('dict')
      .orderBy('code')
      .orderBy('version')
      .execute(),
    config: await h.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

it('[AC-F1-02z#3] int32 最大版本后台与公共读取一致，保存和回滚仍拒绝；非法版本均无覆盖', async () => {
  for (const value of ['2147483648', '01', 'dict-42', String(MAX)]) {
    const attemptedWrites: string[] = [];
    const db = h.db.withPlugin({
      transformQuery({ node }) {
        if (node.kind === 'InsertQueryNode' || node.kind === 'UpdateQueryNode') {
          // Orchestrator mechanical fix: the admin login's UPDATE carries a bigint (totp_last_step).
          const text = JSON.stringify(node, (_k, v: unknown) =>
            typeof v === 'bigint' ? v.toString() : v,
          );
          for (const table of [
            'dict_items',
            'config_items',
            'config_item_versions',
            'audit_logs',
          ]) {
            if (text.includes(`"name":"${table}"`)) attemptedWrites.push(table);
          }
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const f = await setup(h, { db });
    await seedVersion(h, f, value);
    const api = await (await factory())('api', f.overrides);
    h.apps.push(api);
    await api.init();
    const trace = randomUUID();
    const response = await api.inject({
      method: 'GET',
      url: '/v1/dict',
      headers: {
        'x-app-id': f.appId,
        'x-platform': 'ios',
        'x-app-version': '2.0.0',
        'x-trace-id': trace,
      },
    });
    const publicDict = await success<Schema<'Dict'>>({ response, trace }, 'dictRead');
    const page = await success<Schema<'AdminDictItemPage'>>(
      await request(f.app, f.token, 'GET', `/admin/v1/dict-items?key_prefix=${KEY}`),
      'dictList',
    );
    expect(page.dict_version).toBe(value);
    expect(publicDict.version).toBe(value);
    const item = page.items.find((row) => row.key === KEY);
    expect(item, 'the known dictionary key must be listed').toBeDefined();

    // Writes use a valid general-class change: 50001 must come from the stored version,
    // not a missing permission, a schema error, or a no-op text change.
    const before = await snapshot(f.appId);
    attemptedWrites.length = 0;
    await rejected(
      await request(f.app, f.token, 'PUT', '/admin/v1/dict-items', {
        expected_version: value,
        changes: [{ key: KEY, text: '请求写入的新诊断入口' }],
      }),
      'dictSave',
      50001,
    );
    expect(await snapshot(f.appId)).toEqual(before);
    // If the writable parser accepts MAX, PG's int32 overflow would also return 50001
    // and roll back. Reject that false positive: no business DML may even be attempted.
    expect(attemptedWrites).toEqual([]);
    await rejected(
      await request(f.app, f.token, 'POST', '/admin/v1/dict-items/rollback', {
        expected_version: value,
        keys: [KEY],
        to_version: 1,
      }),
      'dictRollback',
      50001,
    );
    expect(await snapshot(f.appId)).toEqual(before);
    expect(attemptedWrites).toEqual([]);

    if (value === String(MAX)) {
      expect(publicDict.items.about?.copy_diagnostics).toBe(TEXT);
      expect(item).toMatchObject({ text: TEXT, version: MAX });
      expect(item?.text).toBe(publicDict.items.about?.copy_diagnostics);
    } else {
      expect(publicDict.items).toEqual({});
      expect(item).toMatchObject({ text: null, version: null });
    }
  }
});
