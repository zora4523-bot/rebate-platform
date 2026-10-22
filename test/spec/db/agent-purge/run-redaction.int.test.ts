import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  DENIED,
  GUEST,
  HASH,
  HASHED_MEMBER,
  MEMBER,
  OTHER_HASH,
  changed,
  close,
  errorFrame,
  fixture,
  open,
  read,
  rejected,
  type Harness,
  type Row,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => close(h));

for (const withText of [false, true]) {
  it(`[AC-B3-09f#4][AC-B3-09f#5][BR-AI-22] member UUID becomes a lowercase 64-hex tuple, idempotently (with user_text=${String(withText)})`, async () => {
    const row = await fixture(h.app, 'agent_runs');
    const values = { quota_subjects: [HASHED_MEMBER], ...(withText ? { user_text: null } : {}) };
    const after = await changed(h.app, 'agent_runs', row, values, values);
    expect(await changed(h.app, 'agent_runs', row, values, values)).toEqual(after);
  });
}

const INVALID_SUBJECTS: { label: string; old: string[]; next: unknown }[] = [
  ...[
    ['uppercase', HASH.toUpperCase()],
    ['63 hex characters', 'a'.repeat(63)],
    ['65 hex characters', 'a'.repeat(65)],
    ['nonhex', 'g'.repeat(64)],
    ['trailing newline', `${HASH}\n`],
  ].map(([label, hash]) => ({
    label: label!,
    old: [MEMBER],
    next: [JSON.stringify(['member', hash])],
  })),
  { label: 'bare hex instead of tuple', old: [MEMBER], next: [HASH] },
  { label: 'tuple kind rename', old: [MEMBER], next: [JSON.stringify(['device', HASH])] },
  {
    label: 'third tuple component',
    old: [MEMBER],
    next: [JSON.stringify(['member', HASH, 'extra'])],
  },
  {
    label: 'other UUID',
    old: [MEMBER],
    next: ['["member","019a0000-0000-7000-8000-000000000456"]'],
  },
  { label: 'hash back to UUID', old: [HASHED_MEMBER], next: [MEMBER] },
  {
    label: 'hash replaced by another hash',
    old: [HASHED_MEMBER],
    next: [JSON.stringify(['member', OTHER_HASH])],
  },
  { label: 'device rewritten', old: GUEST, next: [JSON.stringify(['device', HASH]), GUEST[1]!] },
  { label: 'ip rewritten', old: GUEST, next: [GUEST[0]!, JSON.stringify(['ip', HASH])] },
  { label: 'guest positions swapped', old: GUEST, next: [...GUEST].reverse() },
  { label: 'guest replaced by member', old: GUEST, next: [HASHED_MEMBER, GUEST[1]!] },
  { label: 'append subject', old: [MEMBER], next: [HASHED_MEMBER, GUEST[0]!] },
  { label: 'remove subject', old: GUEST, next: [GUEST[0]!] },
  { label: 'empty array', old: [MEMBER], next: [] },
  { label: 'NULL array', old: [MEMBER], next: null },
  { label: 'NULL element', old: [MEMBER], next: [null] },
  { label: 'unrelated whole column', old: [MEMBER], next: ['synthetic-other-subject'] },
];
for (const { label, old, next } of INVALID_SUBJECTS) {
  it(`[AC-B3-09f#4][BR-AI-22] quota_subjects rejects ${label} atomically even alongside valid user_text clearing`, async () => {
    const row = await fixture(h.app, 'agent_runs', { quota_subjects: old });
    await rejected(h.app, 'agent_runs', row, { quota_subjects: next, user_text: null });
    expect(await read(h.app, 'agent_runs', row)).toEqual(row);
  });
}

it('[AC-B3-09f#4][BR-AI-22] unchanged guest tuples remain usable when user_text clears', async () => {
  const row = await fixture(h.app, 'agent_runs', { quota_subjects: GUEST });
  const values = { quota_subjects: GUEST, user_text: null };
  expect(await changed(h.app, 'agent_runs', row, values, values)).toEqual({ ...row, ...values });
});

// B3-09f §9 specifies a per-position rule rather than reclassifying old rows.
for (const memberIndex of [0, 1]) {
  it(`[AC-B3-09f#4][BR-AI-22] a member at position ${String(memberIndex)} changes without moving or changing the other subject`, async () => {
    const old = memberIndex === 0 ? [MEMBER, GUEST[1]!] : [GUEST[0]!, MEMBER];
    const next = memberIndex === 0 ? [HASHED_MEMBER, GUEST[1]!] : [GUEST[0]!, HASHED_MEMBER];
    const row = await fixture(h.app, 'agent_runs', { quota_subjects: old });
    await rejected(h.app, 'agent_runs', row, { quota_subjects: [...next].reverse() });
    expect(
      await changed(h.app, 'agent_runs', row, { quota_subjects: next }, { quota_subjects: next }),
    ).toEqual({ ...row, quota_subjects: next });
  });
}

function endingSeed(column: 'final_event' | 'end_draft', frame: unknown = errorFrame()): Row {
  return {
    end_reason: 'error',
    [column]: JSON.stringify(frame),
    ...(column === 'final_event' ? { ended_at: AT, settle_result: 'counted', settled_at: AT } : {}),
  };
}

// Additional ACs from the final adjudication: redact only free-text values in
// stored terminal envelopes, retaining keys and all non-text facts.
for (const column of ['final_event', 'end_draft'] as const) {
  for (const fields of [['msg'], ['fallback_q'], ['msg', 'fallback_q']]) {
    it(`[AC-B3-09f#9][AC-B3-09f#5][BR-AI-22] ${column} clears ${fields.join('+')} to JSON null and preserves the envelope`, async () => {
      const row = await fixture(h.app, 'agent_runs', endingSeed(column));
      const expected = errorFrame() as { type: string; data: Row };
      for (const field of fields) expected.data[field] = null;
      const values = { [column]: JSON.stringify(expected) };
      const cleared = await changed(h.app, 'agent_runs', row, values, { [column]: expected });
      expect(await changed(h.app, 'agent_runs', row, values, { [column]: expected })).toEqual(
        cleared,
      );
      await rejected(h.app, 'agent_runs', row, { [column]: JSON.stringify(errorFrame()) });
    });
  }

  const frame = errorFrame();
  const mutations: [string, unknown][] = [
    ['SQL NULL envelope', null],
    ['JSON null envelope', 'null'],
    ['empty envelope', '{}'],
    ['replace msg', JSON.stringify({ ...frame, data: { ...frame.data, msg: '别的' } })],
    [
      'replace fallback_q',
      JSON.stringify({ ...frame, data: { ...frame.data, fallback_q: '别的' } }),
    ],
    [
      'remove text key',
      JSON.stringify({
        ...frame,
        data: { code: 50302, retryable: true, fallback: 'search_page', fallback_q: null },
      }),
    ],
    ['remove data', '{"type":"error"}'],
    ['add text key', JSON.stringify({ ...frame, data: { ...frame.data, extra: null } })],
    ['replace event type', JSON.stringify({ ...frame, type: 'done' })],
    ['clear event type', JSON.stringify({ ...frame, type: null })],
    [
      'change code while clearing text',
      JSON.stringify({ ...frame, data: { ...frame.data, code: 50001, msg: null } }),
    ],
    ['clear code', JSON.stringify({ ...frame, data: { ...frame.data, code: null } })],
    ['clear retryable', JSON.stringify({ ...frame, data: { ...frame.data, retryable: null } })],
    ['change retryable', JSON.stringify({ ...frame, data: { ...frame.data, retryable: false } })],
    [
      'clear structural fallback',
      JSON.stringify({ ...frame, data: { ...frame.data, fallback: null } }),
    ],
    [
      'change structural fallback',
      JSON.stringify({ ...frame, data: { ...frame.data, fallback: 'synthetic-other' } }),
    ],
    ['replace text by object', JSON.stringify({ ...frame, data: { ...frame.data, msg: {} } })],
    ['replace data by JSON null', JSON.stringify({ ...frame, data: null })],
  ];
  for (const [label, value] of mutations) {
    it(`[AC-B3-09f#10][BR-AI-22] ${column} rejects ${label} without partial user_text clearing`, async () => {
      const row = await fixture(h.app, 'agent_runs', endingSeed(column));
      await rejected(h.app, 'agent_runs', row, { [column]: value, user_text: null });
      expect(await read(h.app, 'agent_runs', row)).toEqual(row);
    });
  }

  it(`[AC-B3-09f#10][BR-AI-22] ${column} must not null arbitrary string-valued metadata or add an absent text field`, async () => {
    const withMetadata = {
      ...frame,
      data: { ...frame.data, system_marker: 'synthetic-system-marker' },
    };
    const row = await fixture(h.app, 'agent_runs', endingSeed(column, withMetadata));
    await rejected(h.app, 'agent_runs', row, {
      [column]: JSON.stringify({
        ...withMetadata,
        data: { ...withMetadata.data, system_marker: null },
      }),
    });
    const withoutQuery = {
      type: 'error',
      data: { code: 50302, msg: 'synthetic answer', retryable: true, fallback: null },
    };
    const absent = await fixture(h.app, 'agent_runs', endingSeed(column, withoutQuery));
    await rejected(h.app, 'agent_runs', absent, {
      [column]: JSON.stringify({
        ...withoutQuery,
        data: { ...withoutQuery.data, fallback_q: null },
      }),
    });
    expect(await read(h.app, 'agent_runs', absent)).toEqual(absent);
  });

  it(`[AC-B3-09f#8][BR-AI-22] ${column} done finish_reason remains immutable`, async () => {
    const done = {
      type: 'done',
      data: { finish_reason: 'stop', ...(column === 'final_event' ? { quota_left: 1 } : {}) },
    };
    const row = await fixture(h.app, 'agent_runs', {
      ...endingSeed(column, done),
      end_reason: 'stop',
    });
    for (const finish_reason of ['cancelled', null]) {
      await rejected(h.app, 'agent_runs', row, {
        [column]: JSON.stringify({ ...done, data: { ...done.data, finish_reason } }),
      });
    }
    expect(await read(h.app, 'agent_runs', row)).toEqual(row);
  });
}

it('[AC-B3-09f#9][BR-AI-22] both ending envelopes, quota_subjects and user_text may redact together', async () => {
  const frame = errorFrame();
  const row = await fixture(h.app, 'agent_runs', {
    ...endingSeed('final_event'),
    end_draft: JSON.stringify(frame),
  });
  const redacted = { ...frame, data: { ...frame.data, msg: null, fallback_q: null } };
  const expected = {
    final_event: redacted,
    end_draft: redacted,
    quota_subjects: [HASHED_MEMBER],
    user_text: null,
  };
  const values = {
    ...expected,
    final_event: JSON.stringify(redacted),
    end_draft: JSON.stringify(redacted),
  };
  expect(await changed(h.app, 'agent_runs', row, values, expected)).toEqual({
    ...row,
    ...expected,
  });
});

it('[AC-B3-09f#8][BR-AI-22] original run guards and immutable-column privileges remain in force', async () => {
  const row = await fixture(h.app, 'agent_runs', {
    ...endingSeed('final_event'),
    end_draft: JSON.stringify(errorFrame()),
    cancel_requested_at: AT,
  });
  // These columns are not granted UPDATE even before B3-09f: PG rejects them
  // with 42501 before the trigger can emit 23001. Do not broaden grants to test it.
  await rejected(h.app, 'agent_runs', row, { prompt_version: 'synthetic@2' }, DENIED);
  await rejected(h.app, 'agent_runs', row, { accepted_at: '2026-10-22T07:59:00Z' }, DENIED);
  for (const values of [
    { ended_at: '2026-10-22T08:01:00Z' },
    { end_reason: 'cancelled' },
    { settle_result: 'refunded' },
    { settled_at: '2026-10-22T08:01:00Z' },
    { cancel_requested_at: null },
    { card_delivered: true },
  ]) {
    await rejected(h.app, 'agent_runs', row, {
      ...values,
      quota_subjects: [HASHED_MEMBER],
      user_text: null,
    });
  }
  expect(await read(h.app, 'agent_runs', row)).toEqual(row);
});
