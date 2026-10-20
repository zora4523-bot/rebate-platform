import { expect, it } from 'vitest';
import {
  NOTE_MAX,
  beijingTime,
  createRequestGate,
  noteLength,
  noteProblem,
  outcomeOf,
  queryFromSearch,
  requestQuery,
  searchOf,
  validNote,
  type ClaimItem,
} from './model.ts';

const item = (patch: Partial<ClaimItem>): ClaimItem => ({
  item_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5ab1',
  sub_order_id: '231005-0987654322',
  evidence: 'strong',
  decision: null,
  reject_reason: null,
  decided_at: null,
  decided_by: null,
  decided_by_name: null,
  row_version: 1,
  matches: [],
  evidence_links: [],
  ...patch,
});

it('[F1-07f] address conditions round-trip and unknown enum values are dropped', () => {
  const query = queryFromSearch('?status=auto_matched&platform=pdd&evidence_level=bad&page=3');
  expect(query).toEqual({
    page: 3,
    status: 'auto_matched',
    platform: 'pdd',
    evidence: undefined,
    q: undefined,
    userId: undefined,
  });
  expect(requestQuery(query)).toEqual({
    page: 3,
    page_size: 20,
    platform: 'pdd',
    status: 'auto_matched',
  });
  expect(queryFromSearch(searchOf(query))).toEqual(query);
  expect(searchOf({ page: 1 })).toBe('');
});

it('[F1-07f] note length counts trimmed characters, time shows Beijing time', () => {
  expect(validNote('  证据核实  ')).toBeUndefined();
  expect(validNote('  证据已核实  ')).toBe('证据已核实');
  expect(beijingTime('2026-10-12T01:15:00Z')).toBe('2026-10-12 09:15');
  expect(beijingTime(null)).toBe('—');
});

it('[F1-07f] note over 200 characters after trimming is refused before any request', () => {
  const max = '证'.repeat(NOTE_MAX);
  expect(NOTE_MAX).toBe(200);
  expect(validNote(`  ${max}  `)).toBe(max);
  expect(noteProblem(`  ${max}  `)).toBeUndefined();
  expect(validNote(`${max}据`)).toBeUndefined();
  expect(noteProblem(`${max}据`)).toBe('long');
  expect(noteProblem(' 证据 ')).toBe('short');
  // Code points, as the contract counts them: 200 emoji (400 UTF-16 units) still fit.
  const emoji = '😀'.repeat(NOTE_MAX);
  expect(noteLength(emoji)).toBe(NOTE_MAX);
  expect(validNote(emoji)).toBe(emoji);
});

it('[F1-07f] a stale refresh read cannot overwrite the claim of a later write', () => {
  const gate = createRequestGate();
  const refresh = gate.issue();
  const write = gate.issue();
  // The refresh GET resolves after the later POST: it is dropped, the POST result applies.
  expect(gate.isLatest(refresh)).toBe(false);
  expect(gate.isLatest(write)).toBe(true);
  const next = gate.issue();
  expect(gate.isLatest(write)).toBe(false);
  expect(gate.isLatest(next)).toBe(true);
});

it('[F1-07f] only system closures of the reviewed item are reported', () => {
  expect(outcomeOf(item({ decision: 'cancelled' }))).toBe('auto_attributed');
  expect(outcomeOf(item({ decision: 'rejected', reject_reason: 'NOT_IN_POOL' }))).toBe(
    'auto_attributed',
  );
  expect(outcomeOf(item({ decision: 'rejected', reject_reason: 'ORDER_INVALID' }))).toBe(
    'order_invalid',
  );
  expect(
    outcomeOf(item({ decision: 'approved', decided_by: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01' })),
  ).toBe('reviewed');
  expect(
    outcomeOf(
      item({
        decision: 'cancelled',
        decided_by: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01',
      }),
    ),
  ).toBe('reviewed');
  expect(outcomeOf(undefined)).toBe('reviewed');
});
