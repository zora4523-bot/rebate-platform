import { expect, it } from 'vitest';
import { parseUnionRecordingProvenance } from '../../../../apps/api/src/modules/union/index.ts';
import { provenance } from './kit.ts';

// Probe here is in-memory parser input only, never a claimed probe recording or evidence.
it.each(['synthetic', 'doc-derived', 'probe'] as const)(
  '[AC-B1-04c-PROVENANCE#1] 读取 %s 的全部来源字段且不改写来源',
  (source) => {
    const input = provenance(source);
    expect(parseUnionRecordingProvenance(input)).toEqual(input);
  },
);

it.each([
  'source',
  'capabilityId',
  'probeRunId',
  'capturedAt',
  'originalSha256',
  'sanitizerVersion',
])('[AC-B1-04c-PROVENANCE#2] provenance 缺少必填字段 %s 必须拒绝', (field) => {
  const input: Record<string, unknown> = { ...provenance() };
  delete input[field];
  expect(() => parseUnionRecordingProvenance(input)).toThrow(
    expect.objectContaining({ code: 'invalid_provenance' }),
  );
});

it.each([
  { source: 'unknown' },
  { source: 'PROBE' },
  { source: null },
  { capabilityId: '' },
  { capabilityId: '  ' },
  { capabilityId: 42 },
  { capturedAt: 'synthetic-not-a-date' },
  { capturedAt: '2030-01-02' },
  { capturedAt: null },
  { originalSha256: 'synthetic-not-a-digest' },
  { originalSha256: 'a'.repeat(63) },
  { originalSha256: 'g'.repeat(64) },
  { sanitizerVersion: '' },
  { sanitizerVersion: '  ' },
  { source: 'probe', probeRunId: null },
  { source: 'probe', probeRunId: '' },
  { source: 'probe', probeRunId: '  ' },
  { probeRunId: 42 },
])('[AC-B1-04c-PROVENANCE#3] 拒绝非法来源字段 %j', (override) => {
  expect(() => parseUnionRecordingProvenance({ ...provenance(), ...override })).toThrow(
    expect.objectContaining({ code: 'invalid_provenance' }),
  );
});

it.each([null, [], 'synthetic', 42])(
  '[AC-B1-04c-PROVENANCE#4] 来源必须为对象，拒绝 %j',
  (input) => {
    expect(() => parseUnionRecordingProvenance(input)).toThrow(
      expect.objectContaining({ code: 'invalid_provenance' }),
    );
  },
);
