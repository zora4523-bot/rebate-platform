// [AC-B1-31#1] request id ↔ trace id; [AC-B1-31#2] the propagator (05 B1-31; 02 §13: the request id
// is a well-formed X-Trace-Id kept as sent, or a random UUID). Expected values come from the
// hand-written oracle in kit.ts. Unit tests: no port, no global registration.
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  createTracePropagator,
  requestIdFromTraceId,
  traceIdFromRequestId,
} from '../../../../apps/api/src/modules/platform/tracing/trace-correlation.ts';
import { resolveTraceId } from '../../../../apps/api/src/modules/platform/tracing/trace-id.ts';
import {
  HEX16,
  HEX32,
  INVALID_SPAN_ID,
  TRACEPARENT,
  UUID,
  hexOf,
  otelApi,
  uuidOf,
  type Ctx,
} from './kit.ts';

const api = otelApi();

/** Request ids 02 §13 rejects (resolveTraceId replaces them): never converted. */
const MALFORMED: readonly unknown[] = [
  undefined,
  null,
  '',
  'abc',
  'trace-abc_123',
  '13987654321',
  'has space',
  '{"x":1}',
  'line\nbreak',
  'A'.repeat(31),
  'A'.repeat(33),
  'A'.repeat(64),
  'g'.repeat(32),
  `${'a'.repeat(32)}\n`,
  '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b\n',
  ' 0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
  '0199a3b4_5c6d_7e8f_9a0b_1c2d3e4f5a6b',
  '0199a3b45c6d-7e8f-9a0b-1c2d3e4f5a6b',
  '{0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b}',
  ['a'.repeat(32)],
  42,
];

it.each([
  ['0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b', '0199a3b45c6d7e8f9a0b1c2d3e4f5a6b'],
  ['C56A4180-65aa-42EC-a945-5fd21DEC0538', 'c56a418065aa42eca9455fd21dec0538'],
  ['abcdefABCDEF01234567abcdefABCDEF', 'abcdefabcdef01234567abcdefabcdef'],
  ['0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
  ['1'.repeat(32), '1'.repeat(32)],
])('[AC-B1-31#1] traceIdFromRequestId(%s) is the 32 lowercase hex digits %s', (input, expected) => {
  expect(traceIdFromRequestId(input)).toBe(expected);
});

it.each(MALFORMED.map((value) => [value]))(
  '[AC-B1-31#1] traceIdFromRequestId(%j) is null: malformed ids are not converted or repaired',
  (value) => {
    expect(traceIdFromRequestId(value)).toBeNull();
  },
);

it.each([
  ['0199a3b45c6d7e8f9a0b1c2d3e4f5a6b', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'],
  ['C56A418065AA42ECA9455FD21DEC0538', 'c56a4180-65aa-42ec-a945-5fd21dec0538'],
  ['ffffffffffffffffffffffffffffffff', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
])('[AC-B1-31#1] requestIdFromTraceId(%s) is the lowercase UUID %s', (input, expected) => {
  expect(requestIdFromTraceId(input)).toBe(expected);
});

it.each(
  [
    undefined,
    null,
    '',
    '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
    'a'.repeat(31),
    'a'.repeat(33),
    'g'.repeat(32),
    `${'a'.repeat(32)}\n`,
    ` ${'a'.repeat(32)}`,
    ['a'.repeat(32)],
    42,
  ].map((value) => [value]),
)('[AC-B1-31#1] requestIdFromTraceId(%j) is null', (value) => {
  expect(requestIdFromTraceId(value)).toBeNull();
});

it('[AC-B1-31#1] every non-zero trace id survives the round trip and is a request id 02 §13 keeps', () => {
  fc.assert(
    fc.property(
      fc
        .uint8Array({ minLength: 16, maxLength: 16 })
        .filter((bytes) => bytes.some((byte) => byte !== 0)),
      (bytes) => {
        const traceId = Buffer.from(bytes).toString('hex');
        const requestId = requestIdFromTraceId(traceId);
        expect(requestId).toBe(uuidOf(traceId));
        expect(requestId).toMatch(UUID);
        // The X-Trace-Id header / envelope trace_id built from it is adopted unchanged (02 §13).
        expect(resolveTraceId(requestId)).toBe(requestId);
        expect(traceIdFromRequestId(requestId)).toBe(traceId);
        expect(requestIdFromTraceId(traceId.toUpperCase())).toBe(requestId);
      },
    ),
  );
});

it('[AC-B1-31#1] every well-formed request id maps to the trace id of its digits, either case', () => {
  fc.assert(
    fc.property(fc.uuid(), fc.boolean(), fc.boolean(), (uuid, upper, dashed) => {
      const cased = upper ? uuid.toUpperCase() : uuid;
      const requestId = dashed ? cased : cased.replaceAll('-', '');
      const traceId = traceIdFromRequestId(requestId);
      expect(traceId).toBe(hexOf(requestId));
      expect(traceId).toMatch(HEX32);
      expect(requestIdFromTraceId(traceId)).toBe(uuid.toLowerCase());
    }),
  );
});

// ----------------------------------------------------------------------------------------------
// [AC-B1-31#2] propagator.

function extract(carrier: Record<string, string>, sampleRatio = 1): Ctx {
  return createTracePropagator({ sampleRatio }).extract(
    api.ROOT_CONTEXT,
    carrier,
    api.defaultTextMapGetter,
  );
}

it.each([
  '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
  'C56A4180-65aa-42EC-a945-5fd21DEC0538',
  'abcdefABCDEF01234567abcdefABCDEF',
])(
  '[AC-B1-31#2] a well-formed x-trace-id %s becomes the remote parent: its trace id, a random span id, sampled',
  (value) => {
    const first = api.trace.getSpanContext(extract({ 'x-trace-id': value }));
    const second = api.trace.getSpanContext(extract({ 'x-trace-id': value }));
    expect(first?.traceId).toBe(hexOf(value));
    expect(first?.isRemote).toBe(true);
    expect(first?.spanId).toMatch(HEX16);
    expect(first?.spanId).not.toBe(INVALID_SPAN_ID);
    expect(first?.traceFlags).toBe(1);
    expect(second?.traceId).toBe(hexOf(value));
    expect(second?.spanId).not.toBe(first?.spanId);
  },
);

it('[AC-B1-31#2] with sample ratio 0 an adopted x-trace-id is not marked sampled', () => {
  const value = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
  const context = api.trace.getSpanContext(extract({ 'x-trace-id': value }, 0));
  expect(context?.traceId).toBe(hexOf(value));
  expect(context?.traceFlags).toBe(0);
});

it.each(
  [
    ...MALFORMED.filter((value): value is string => typeof value === 'string'),
    '00000000-0000-0000-0000-000000000000',
    '0'.repeat(32),
  ].map((value) => [value]),
)('[AC-B1-31#2] a malformed x-trace-id %j adds no parent (the SDK starts a new trace)', (value) => {
  const propagator = createTracePropagator({ sampleRatio: 1 });
  const context = propagator.extract(
    api.ROOT_CONTEXT,
    { 'x-trace-id': value },
    api.defaultTextMapGetter,
  );
  expect(api.trace.getSpanContext(context)).toBeUndefined();
});

it('[AC-B1-31#2] without x-trace-id nothing is extracted, an inbound traceparent included', () => {
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  expect(api.trace.getSpanContext(extract({}))).toBeUndefined();
  expect(api.trace.getSpanContext(extract({ traceparent }))).toBeUndefined();
  // Both present: the trace is the x-trace-id's, not the traceparent's.
  const both = api.trace.getSpanContext(
    extract({ traceparent, 'x-trace-id': '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b' }),
  );
  expect(both?.traceId).toBe('0199a3b45c6d7e8f9a0b1c2d3e4f5a6b');
});

it.each([
  [1, '01'],
  [0, '00'],
] as const)(
  '[AC-B1-31#2] inject writes traceparent (flags %s) and x-trace-id in UUID form for the active span',
  (traceFlags, flags) => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const context = api.trace.setSpanContext(api.ROOT_CONTEXT, { traceId, spanId, traceFlags });
    const carrier: Record<string, string> = {};
    createTracePropagator({ sampleRatio: 1 }).inject(context, carrier, api.defaultTextMapSetter);
    expect(carrier['traceparent']).toBe(`00-${traceId}-${spanId}-${flags}`);
    expect(carrier['traceparent']).toMatch(TRACEPARENT);
    expect(carrier['x-trace-id']).toBe('4bf92f35-77b3-4da6-a3ce-929d0e0e4736');
  },
);

it('[AC-B1-31#2] inject writes nothing without a valid span context', () => {
  const propagator = createTracePropagator({ sampleRatio: 1 });
  const none: Record<string, string> = {};
  propagator.inject(api.ROOT_CONTEXT, none, api.defaultTextMapSetter);
  expect(none).toEqual({});
  const invalid: Record<string, string> = {};
  propagator.inject(
    api.trace.setSpanContext(api.ROOT_CONTEXT, {
      traceId: '0'.repeat(32),
      spanId: INVALID_SPAN_ID,
      traceFlags: 1,
    }),
    invalid,
    api.defaultTextMapSetter,
  );
  expect(invalid).toEqual({});
});

it('[AC-B1-31#2] the propagator declares traceparent and x-trace-id as its fields', () => {
  const fields = createTracePropagator({ sampleRatio: 1 }).fields();
  expect(fields).toContain('traceparent');
  expect(fields).toContain('x-trace-id');
});

it('[AC-B1-31#2] extract after inject keeps the trace: the downstream request id names the same trace', () => {
  const traceId = 'c56a418065aa42eca9455fd21dec0538';
  const outbound: Record<string, string> = {};
  const propagator = createTracePropagator({ sampleRatio: 1 });
  propagator.inject(
    api.trace.setSpanContext(api.ROOT_CONTEXT, {
      traceId,
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
    }),
    outbound,
    api.defaultTextMapSetter,
  );
  const downstream = api.trace.getSpanContext(
    propagator.extract(api.ROOT_CONTEXT, outbound, api.defaultTextMapGetter),
  );
  expect(downstream?.traceId).toBe(traceId);
  expect(outbound['x-trace-id']).toMatch(UUID);
});
