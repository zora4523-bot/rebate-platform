import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  changed,
  close,
  fixture,
  open,
  read,
  rejected,
  type Harness,
  type Row,
  type Table,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => close(h));

// BR-AI-22 and the B3-09f §9 defaults: preserve NOT NULL/CHECK constraints,
// keep the fixed fallback label and the system-owned chain_id, never delete rows.
const CLEARINGS: {
  table: Table;
  label: string;
  seed?: Row;
  writes: Row;
  expected: Row;
}[] = [
  ...['text', 'report_reason', 'report_note'].map((column) => ({
    table: 'agent_messages' as const,
    label: column,
    writes: { [column]: null },
    expected: { [column]: null },
  })),
  { table: 'agent_tool_calls', label: 'args', writes: { args: null }, expected: { args: null } },
  {
    table: 'agent_cards',
    label: 'notice data + fallback',
    writes: { data: '{}', fallback_text: '内容已删除' },
    expected: { data: {}, fallback_text: '内容已删除' },
  },
  {
    table: 'agent_cards',
    label: 'earnings_summary data + fallback',
    seed: {
      type: 'earnings_summary',
      data: '{"as_of":"2026-10-22T08:00:00.000Z","actions":[]}',
    },
    writes: { data: '{}', fallback_text: '内容已删除' },
    expected: { data: {}, fallback_text: '内容已删除' },
  },
  {
    table: 'agent_result_sets',
    label: 'conditions',
    writes: { conditions: '{}' },
    expected: { conditions: {} },
  },
  {
    table: 'agent_result_deliveries',
    label: 'card',
    writes: { card: '{}' },
    expected: { card: {} },
  },
  {
    table: 'agent_result_chains',
    label: 'conditions preserving chain_id',
    writes: { conditions: '{"chain_id":"synthetic-chain"}' },
    expected: { conditions: { chain_id: 'synthetic-chain' } },
  },
  {
    table: 'agent_runs',
    label: 'user_text',
    writes: { user_text: null },
    expected: { user_text: null },
  },
];

for (const { table, label, seed, writes, expected } of CLEARINGS) {
  it(`[AC-B3-09f#1][AC-B3-09f#5][BR-AI-22] ${table}.${label} clears idempotently, retaining every other column`, async () => {
    const row = await fixture(h.app, table, seed);
    const cleared = await changed(h.app, table, row, writes, expected);
    const repeated = await changed(h.app, table, row, writes, expected);
    expect(repeated).toEqual(cleared);
  });
}

for (const first of ['data', 'fallback_text']) {
  it(`[AC-B3-09f#1][BR-AI-22] card ${first} can clear separately while the other column remains unchanged`, async () => {
    const row = await fixture(h.app, 'agent_cards');
    if (first === 'data') {
      await changed(h.app, 'agent_cards', row, { data: '{}' }, { data: {} });
      await changed(
        h.app,
        'agent_cards',
        row,
        { fallback_text: '内容已删除' },
        { fallback_text: '内容已删除' },
      );
    } else {
      await changed(
        h.app,
        'agent_cards',
        row,
        { fallback_text: '内容已删除' },
        { fallback_text: '内容已删除' },
      );
      await changed(h.app, 'agent_cards', row, { data: '{}' }, { data: {} });
    }
    expect(await read(h.app, 'agent_cards', row)).toEqual({
      ...row,
      data: {},
      fallback_text: '内容已删除',
    });
  });
}

const REWRITES: { table: Table; column: string; value: unknown; clear: unknown }[] = [
  { table: 'agent_tool_calls', column: 'args', value: '{"q":"x"}', clear: null },
  { table: 'agent_tool_calls', column: 'args', value: 'null', clear: null },
  { table: 'agent_cards', column: 'data', value: '{"a":1}', clear: '{}' },
  { table: 'agent_cards', column: 'fallback_text', value: '别的', clear: '内容已删除' },
  { table: 'agent_result_sets', column: 'conditions', value: '{"q":"x"}', clear: '{}' },
  { table: 'agent_result_deliveries', column: 'card', value: '{"title":"x"}', clear: '{}' },
  {
    table: 'agent_result_chains',
    column: 'conditions',
    value: '{"chain_id":"synthetic-chain","q":"x"}',
    clear: '{"chain_id":"synthetic-chain"}',
  },
  { table: 'agent_runs', column: 'user_text', value: '别的', clear: null },
];
for (const { table, column, value, clear } of REWRITES) {
  it(`[AC-B3-09f#2][BR-AI-22] ${table}.${column} rejects ${String(value)} both before and after clearing`, async () => {
    const row = await fixture(h.app, table);
    await rejected(h.app, table, row, { [column]: value });
    await changed(
      h.app,
      table,
      row,
      { [column]: clear },
      {
        [column]:
          clear === null || column === 'fallback_text' ? clear : JSON.parse(clear as string),
      },
    );
    await rejected(h.app, table, row, { [column]: value });
    // Restoring the original private content is also forbidden.
    const original = row[column];
    const restored =
      original !== null && typeof original === 'object' ? JSON.stringify(original) : original;
    await rejected(h.app, table, row, { [column]: restored });
    expect((await read(h.app, table, row))[column]).not.toEqual(original);
  });
}

it('[AC-B3-09f#2][BR-AI-22] clearing one card field cannot smuggle a nonempty rewrite of the other', async () => {
  const row = await fixture(h.app, 'agent_cards');
  await rejected(h.app, 'agent_cards', row, { data: '{}', fallback_text: '别的' });
  await rejected(h.app, 'agent_cards', row, { data: '{"a":1}', fallback_text: '内容已删除' });
  expect(await read(h.app, 'agent_cards', row)).toEqual(row);
});

it('[AC-B3-09f#1][BR-AI-22] chain redaction preserves its actual system ID in every allowed status', async () => {
  for (const status of ['searching', 'awaiting_price', 'has_products']) {
    const chainId = `synthetic-${status}`;
    const row = await fixture(h.app, 'agent_result_chains', {
      status,
      chain_id: chainId,
      conditions: JSON.stringify({ chain_id: chainId, q: 'synthetic private query' }),
    });
    await changed(
      h.app,
      'agent_result_chains',
      row,
      { conditions: JSON.stringify({ chain_id: chainId }) },
      { conditions: { chain_id: chainId } },
    );
    expect((await read(h.app, 'agent_result_chains', row))['status']).toBe(status);
  }
});

it('[AC-B3-09f#5][BR-AI-22] SQL NULL args and user_text remain NULL on repeated clearing', async () => {
  for (const [table, column] of [
    ['agent_tool_calls', 'args'],
    ['agent_runs', 'user_text'],
  ] as const) {
    const row = await fixture(h.app, table, { [column]: null });
    expect(await changed(h.app, table, row, { [column]: null }, { [column]: null })).toEqual(row);
  }
});

it('[AC-B3-09f#7][BR-AI-22] messages retain ordinary feedback and report edits and gain no rewrite trigger', async () => {
  const row = await fixture(h.app, 'agent_messages');
  const values = {
    feedback: 'down',
    feedback_at: AT,
    badcase: true,
    report_note: 'synthetic updated note',
  };
  expect(await changed(h.app, 'agent_messages', row, values, values)).toEqual({
    ...row,
    ...values,
  });
});
