import { expect, it } from 'vitest';

import { columns, constraints, indexes } from './catalog.ts';
import { EVIDENCE, DECISIONS, REASONS, STATUSES, TABLES, ready, useHarness } from './kit.ts';

const h = useHarness();

it('[AC-B1-10a#1] claims columns have the exact types, nullability and application defaults', async () => {
  await ready(h.app);
  const expected = [
    ['id', 'uuid', false],
    ['app_id', 'text', false],
    ['user_id', 'uuid', false],
    ['platform', 'text', false],
    ['order_no', 'text', false],
    ['order_no_type', 'text', false],
    ['paid_date', 'date', false],
    ['evidence_level', 'text', true],
    ['status', 'text', false],
    ['handler_admin_id', 'uuid', true],
    ['reason', 'text', true],
    ['row_version', 'int4', false],
    ['created_at', 'timestamptz', false],
    ['updated_at', 'timestamptz', false],
  ].map(([name, type, nullable]) => ({
    name,
    type,
    nullable,
    expression: name === 'row_version' ? '0' : null,
    identity: 'NO',
    generated: 'NEVER',
  }));
  expect(new Set(await columns(h.app, 'claims'))).toEqual(new Set(expected));
});

it('[AC-B1-10a#2] claim_items columns preserve bigint references and nullable pending decision', async () => {
  await ready(h.app);
  const expected = [
    ['id', 'uuid', false],
    ['app_id', 'text', false],
    ['claim_id', 'uuid', false],
    ['applicant_user_id', 'uuid', false],
    ['platform', 'text', false],
    ['sub_order_id', 'text', false],
    ['order_id', 'uuid', false],
    ['evidence', 'text', true],
    ['evidence_link_log_ids', '_int8', true],
    ['decision', 'text', true],
    ['reject_reason', 'text', true],
    ['decided_by', 'uuid', true],
    ['decided_at', 'timestamptz', true],
    ['row_version', 'int4', false],
    ['created_at', 'timestamptz', false],
    ['updated_at', 'timestamptz', false],
  ].map(([name, type, nullable]) => ({
    name,
    type,
    nullable,
    expression: name === 'row_version' ? '0' : name === 'created_at' ? 'now()' : null,
    identity: 'NO',
    generated: 'NEVER',
  }));
  expect(new Set(await columns(h.app, 'claim_items'))).toEqual(new Set(expected));
});

it('[AC-B1-10a#3] named primary and business unique keys compare column sets', async () => {
  await ready(h.app);
  for (const [table, expected] of [
    [
      'claims',
      [
        ['claims_pkey', 'p', ['id']],
        ['claims_item_ref_key', 'u', ['app_id', 'id', 'user_id', 'platform']],
      ],
    ],
    [
      'claim_items',
      [
        ['claim_items_pkey', 'p', ['id']],
        [
          'claim_items_applicant_order_key',
          'u',
          ['app_id', 'applicant_user_id', 'platform', 'sub_order_id'],
        ],
      ],
    ],
  ] as const) {
    const actual = (await constraints(h.app, table)).filter((c) => ['p', 'u'].includes(c.kind));
    expect(new Set(actual.map((c) => [c.name, c.kind, new Set(c.keys)]))).toEqual(
      new Set(expected.map(([name, kind, keys]) => [name, kind, new Set(keys)])),
    );
  }
});

it('[AC-B1-10a#4] named foreign keys bind tenants and only reference ordinary app tables', async () => {
  await ready(h.app);
  for (const [table, expected] of [
    [
      'claims',
      [
        ['claims_user_fkey', ['app_id', 'user_id'], 'users', ['app_id', 'id']],
        ['claims_platform_fkey', ['platform'], 'platforms', ['code']],
        [
          'claims_handler_admin_fkey',
          ['app_id', 'handler_admin_id'],
          'admin_users',
          ['app_id', 'id'],
        ],
      ],
    ],
    [
      'claim_items',
      [
        [
          'claim_items_claim_fkey',
          ['app_id', 'claim_id', 'applicant_user_id', 'platform'],
          'claims',
          ['app_id', 'id', 'user_id', 'platform'],
        ],
        [
          'claim_items_order_key_fkey',
          ['app_id', 'platform', 'sub_order_id', 'order_id'],
          'order_keys',
          ['app_id', 'platform', 'sub_order_id', 'order_id'],
        ],
        ['claim_items_decided_by_fkey', ['app_id', 'decided_by'], 'admin_users', ['app_id', 'id']],
      ],
    ],
  ] as const) {
    const actual = (await constraints(h.app, table)).filter((c) => c.kind === 'f');
    expect(
      new Set(actual.map((c) => [c.name, new Set(c.keys), c.target, new Set(c.target_keys)])),
    ).toEqual(
      new Set(
        expected.map(([name, keys, target, targetKeys]) => [
          name,
          new Set(keys),
          target,
          new Set(targetKeys),
        ]),
      ),
    );
    for (const c of actual) {
      expect(c.target_schema, c.name).toBe('app');
      expect(c.target_kind, c.name).toBe('r');
      expect(['a', 'r'], c.name).toContain(c.on_update);
      expect(['a', 'r'], c.name).toContain(c.on_delete);
      expect(c.validated, c.name).toBe(true);
    }
  }
});

it('[AC-B1-10a#5] J-a order_keys has the named four-column unique reference key', async () => {
  await ready(h.app);
  const key = (await constraints(h.app, 'order_keys')).filter(
    (c) => c.name === 'order_keys_claim_ref_key',
  );
  expect(key).toHaveLength(1);
  expect(key[0]).toMatchObject({ kind: 'u', validated: true });
  expect(new Set(key[0]?.keys)).toEqual(
    new Set(['app_id', 'platform', 'sub_order_id', 'order_id']),
  );
});

it('[AC-B1-10a#6] named CHECK sets and enum literals match the storage contract', async () => {
  await ready(h.app);
  const expected = {
    claims: {
      claims_order_no_check: null,
      claims_order_no_type_check: ['sub', 'parent'],
      claims_evidence_level_check: EVIDENCE,
      claims_evidence_status_check: null,
      claims_status_check: STATUSES,
    },
    claim_items: {
      claim_items_evidence_check: EVIDENCE,
      claim_items_evidence_links_check: null,
      claim_items_decision_check: DECISIONS,
      claim_items_reject_reason_check: REASONS,
      claim_items_reject_reason_pair_check: null,
      claim_items_decided_pair_check: null,
    },
  };
  for (const table of TABLES) {
    const checks = (await constraints(h.app, table)).filter((c) => c.kind === 'c');
    expect(new Set(checks.map((c) => c.name))).toEqual(new Set(Object.keys(expected[table])));
    for (const [name, values] of Object.entries(expected[table])) {
      const check = checks.find((c) => c.name === name);
      expect(check?.validated, name).toBe(true);
      if (values !== null) {
        const literals = [...(check?.definition ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
        expect(new Set(literals), name).toEqual(new Set(values));
      }
    }
  }
});

it('[AC-B1-10a#7] user and claim lookup indexes have named column sets and correct sort direction', async () => {
  await ready(h.app);
  for (const [table, name, keys, descending] of [
    ['claims', 'claims_user_created_idx', ['app_id', 'user_id', 'created_at'], ['created_at']],
    ['claim_items', 'claim_items_claim_idx', ['app_id', 'claim_id'], []],
  ] as const) {
    const index = (await indexes(h.app, table)).find((i) => i.name === name);
    expect(index).toMatchObject({ valid: true, ready: true, unique: false, predicate: null });
    expect(new Set(index?.keys)).toEqual(new Set(keys));
    expect(new Set(index?.descending)).toEqual(new Set(descending));
  }
});
