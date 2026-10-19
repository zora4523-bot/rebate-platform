import { expect, it } from 'vitest';
import { FixedClock, type AuditInput } from '../../platform/index.ts';
import type { FundTermKeys } from '../domain/text-guard/index.ts';
import {
  DictConflictError,
  DictFieldsError,
  DictItemAdmin,
  DictVersionCorruptError,
  type DictEffective,
  type DictItemInsert,
  type DictItemStore,
  type DictVersionRow,
  type DictWriteTx,
} from './dict-item-admin.ts';

const AT = '2026-10-19T01:00:00.000Z';
const APP = 'dict_unit';
const actor = { appId: APP, adminId: 'admin-1', loginName: 'editor', ip: '127.0.0.1' };
const FUND: FundTermKeys = {
  fund_terms: { prefixes: ['wallet.'], keys: [], notify_templates: [] },
  ordinary: { prefixes: ['about.', 'privacy.'], keys: [], notify_templates: [] },
  exempt: [],
};
const DEFAULTS = {
  'about.a': '甲',
  'about.b': '乙{name}',
  'privacy.ok': '同意',
  'wallet.x': '余额',
};

/**
 * In-memory model of the PostgreSQL behaviour the store relies on: lockVersion holds a per-app
 * lock until the transaction ends (SELECT … FOR UPDATE), writes become visible only on commit, a
 * second first-publish fails on the primary key, and a thrown error rolls everything back.
 */
function memoryStore() {
  const state = {
    version: undefined as DictVersionRow | undefined,
    items: [] as DictItemInsert[],
    history: [] as { version: number; value: string }[],
    audits: [] as AuditInput[],
  };
  let lock: Promise<void> = Promise.resolve();
  const effectiveOf = (
    items: readonly DictItemInsert[],
    at: number,
    keys?: readonly string[],
  ): Map<string, DictEffective> => {
    const found = new Map<string, DictEffective>();
    for (const item of items) {
      if (item.version > at || (keys !== undefined && !keys.includes(item.key))) continue;
      const seen = found.get(item.key);
      if (seen === undefined || seen.version < item.version) {
        found.set(item.key, { text: item.text, version: item.version });
      }
    }
    return found;
  };
  const store: DictItemStore = {
    read: (work) =>
      work({
        dictVersion: async () => state.version,
        effective: async (_app, at, keys) => effectiveOf(state.items, at, keys),
      }),
    history: () => Promise.reject(new Error('not used')),
    appendAudit: async (input) => {
      state.audits.push(input);
    },
    async transaction(work) {
      let release = () => undefined as void;
      let locked = false;
      const pending = {
        version: undefined as DictVersionRow | undefined,
        published: false,
        items: [] as DictItemInsert[],
        history: [] as { version: number; value: string }[],
        audits: [] as AuditInput[],
      };
      const tx: DictWriteTx = {
        dictVersion: async () => state.version,
        effective: async (_app, at, keys) => effectiveOf(state.items, at, keys),
        async lockVersion() {
          const previous = lock;
          lock = new Promise<void>((resolve) => {
            release = resolve;
          });
          locked = true;
          await previous;
          return state.version;
        },
        async publish(input) {
          const version = (input.previous?.version ?? 0) + 1;
          pending.version = { value: input.value, version };
          pending.published = true;
          pending.history.push({ version, value: input.value });
        },
        async insertItems(rows) {
          pending.items.push(...rows);
        },
        async audit(input) {
          pending.audits.push(input);
        },
      };
      try {
        const result = await work(tx);
        if (pending.published) {
          // The primary key of config_items: two first publishes cannot both commit.
          if (state.version !== undefined && pending.version!.version === 1) {
            throw new DictConflictError();
          }
          state.version = pending.version;
        }
        state.items.push(...pending.items);
        state.history.push(...pending.history);
        state.audits.push(...pending.audits);
        return result;
      } finally {
        if (locked) release();
      }
    },
  };
  return { state, store };
}

function fixture() {
  const clock = new FixedClock(AT);
  const memory = memoryStore();
  const admin = new DictItemAdmin(memory.store, clock, {
    defaults: () => DEFAULTS,
    fundTermKeys: () => FUND,
    rules: () => ({
      defaults: DEFAULTS,
      words: [{ word: '全网最低', category: 'price_rebate', scopes: ['user_visible'] }],
    }),
  });
  return { ...memory, admin, clock };
}

it('[AC-F1-02t#u7] 首存：新版本 "1"、逐键一行、审计带前后值与资金术语标记', async () => {
  const f = fixture();
  const result = await f.admin.save(actor, {
    changes: [
      { key: 'about.a', text: '甲新' },
      { key: 'about.b', text: '乙{name}新' },
    ],
    expected_version: '0',
  });
  expect(result).toEqual({ version: '1', keys: ['about.a', 'about.b'] });
  expect(f.state.version).toEqual({ value: '1', version: 1 });
  expect(f.state.items.map((x) => [x.key, x.version, x.text, x.createdBy])).toEqual([
    ['about.a', 1, '甲新', 'admin-1'],
    ['about.b', 1, '乙{name}新', 'admin-1'],
  ]);
  expect(f.state.items.every((x) => x.at.toISOString() === AT)).toBe(true);
  expect(f.state.audits).toEqual([
    {
      appId: APP,
      actor: 'admin-1',
      action: 'dict_items_save',
      target: 'dict_items',
      before: {
        dict_version: '0',
        items: [
          { key: 'about.a', text: null },
          { key: 'about.b', text: null },
        ],
      },
      after: {
        dict_version: '1',
        items: [
          { key: 'about.a', text: '甲新' },
          { key: 'about.b', text: '乙{name}新' },
        ],
        fund_terms: false,
        legal_confirmed_by: null,
      },
      ip: '127.0.0.1',
    },
  ]);
});

it('[AC-F1-02t#u8] 先校验再 CAS：校验错 20001 优先于版本不符；版本只做字符串全等', async () => {
  const f = fixture();
  await expect(
    f.admin.save(actor, { changes: [{ key: 'about.b', text: '缺变量' }], expected_version: '9' }),
  ).rejects.toEqual(new DictFieldsError(['changes[0].text']));
  await expect(
    f.admin.save(actor, { changes: [{ key: 'about.a', text: '甲' }], expected_version: '00' }),
  ).rejects.toBeInstanceOf(DictConflictError);
  expect(f.state.items).toEqual([]);
  expect(f.state.audits).toEqual([]);
});

it('[AC-F1-02t#u9] 并发两写同一 expected：行锁串行，恰一个成功，另一个 20902，版本不重复', async () => {
  for (const seeded of [false, true]) {
    const f = fixture();
    if (seeded) {
      await f.admin.save(actor, {
        changes: [{ key: 'about.a', text: '起点' }],
        expected_version: '0',
      });
    }
    const expected = seeded ? '1' : '0';
    const results = await Promise.allSettled(
      ['并发甲', '并发乙'].map((text) =>
        f.admin.save(actor, { changes: [{ key: 'about.a', text }], expected_version: expected }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(DictConflictError);
    const versions = f.state.items.map((x) => x.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(f.state.version?.value).toBe(String(Number(expected) + 1));
  }
});

it('[AC-F1-02t#u10] 当前 dict_version 不是整数串 → 50001 类错误，什么都不写', async () => {
  const f = fixture();
  f.state.version = { value: 'dict-42', version: 1 };
  await expect(
    f.admin.save(actor, {
      changes: [{ key: 'about.a', text: '甲新' }],
      expected_version: 'dict-42',
    }),
  ).rejects.toBeInstanceOf(DictVersionCorruptError);
  expect(f.state.items).toEqual([]);
  // Reads show the stored value and no override.
  const page = await f.admin.list(APP, {});
  expect(page.dict_version).toBe('dict-42');
  expect(page.items.every((x) => x.text === null && x.version === null)).toBe(true);
});

it('[AC-F1-02t#u11] 回滚以旧值写新版本，历史行不改；0 恢复 null；审计带 to_version', async () => {
  const f = fixture();
  await f.admin.save(actor, { changes: [{ key: 'about.a', text: 'A' }], expected_version: '0' });
  await f.admin.save(actor, { changes: [{ key: 'about.a', text: 'B' }], expected_version: '1' });
  const history = structuredClone(f.state.items);
  expect(
    await f.admin.rollback(actor, { keys: ['about.a'], to_version: 1, expected_version: '2' }),
  ).toEqual({ version: '3', keys: ['about.a'] });
  expect(f.state.items.slice(0, 2)).toEqual(history);
  expect(f.state.items.at(-1)).toMatchObject({ key: 'about.a', version: 3, text: 'A' });
  expect(f.state.audits.at(-1)).toMatchObject({
    action: 'dict_items_rollback',
    before: { dict_version: '2', items: [{ key: 'about.a', text: 'B' }] },
    after: { dict_version: '3', items: [{ key: 'about.a', text: 'A' }], to_version: 1 },
  });
  await f.admin.rollback(actor, { keys: ['about.a'], to_version: 0, expected_version: '3' });
  expect(f.state.items.at(-1)).toMatchObject({ key: 'about.a', version: 4, text: null });
  await expect(
    f.admin.rollback(actor, { keys: ['about.a'], to_version: 4, expected_version: 'x' }),
  ).rejects.toEqual(new DictFieldsError(['to_version']));
});

it('[AC-F1-02t#u12] 列表：键序、类别与前缀过滤、分页，只取已发布版本内的值', async () => {
  const f = fixture();
  await f.admin.save(actor, { changes: [{ key: 'about.a', text: '甲新' }], expected_version: '0' });
  // A row above the published version (written but not published) is not shown.
  f.state.items.push({ ...f.state.items[0]!, version: 2, text: '未发布' });
  const all = await f.admin.list(APP, { page_size: 200 });
  expect(all.items.map((x) => [x.key, x.class, x.text, x.version])).toEqual([
    ['about.a', 'general', '甲新', 1],
    ['about.b', 'general', null, null],
    ['privacy.ok', 'agreement', null, null],
    ['wallet.x', 'fund_terms', null, null],
  ]);
  expect(all).toMatchObject({ total: 4, dict_version: '1', page: 1, page_size: 200 });
  const filtered = await f.admin.list(APP, { class: 'general', page: 2, page_size: 1 });
  expect(filtered.items.map((x) => x.key)).toEqual(['about.b']);
  expect(filtered.total).toBe(2);
  expect((await f.admin.list(APP, { key_prefix: 'priv' })).items.map((x) => x.key)).toEqual([
    'privacy.ok',
  ]);
});

it('[AC-F1-02t#u13] 被拒写入单独审计被拒键与拒绝码；混类与空请求在选点前 20001', async () => {
  const f = fixture();
  await f.admin.denied({ appId: APP, adminId: 'admin-2', ip: null }, 'save', ['wallet.x'], 10403);
  expect(f.state.audits).toEqual([
    {
      appId: APP,
      actor: 'admin-2',
      action: 'dict_items_denied',
      target: 'dict_items',
      before: null,
      after: { operation: 'save', keys: ['wallet.x'], code: 10403, fund_terms: true },
      ip: null,
    },
  ]);
  expect(() => f.admin.requestClass(['about.a', 'wallet.x'], 'changes')).toThrow(
    new DictFieldsError(['changes']),
  );
  expect(() => f.admin.requestClass([], 'keys')).toThrow(new DictFieldsError(['keys']));
  expect(f.admin.requestClass(['unknown.key'], 'keys')).toBe('fund_terms');
});
