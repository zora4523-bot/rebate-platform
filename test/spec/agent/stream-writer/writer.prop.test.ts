// B3-03a property: for any run of non-terminal frames (any delta text, pings anywhere) ended by
// one done or error, the frames emit() returns and the SSE text read back both equal frames built
// here from the generated steps with hand-counted seq (never from the writer's output); ids are
// 1..n without gaps, the terminal frame is the only one and the last, and every frame passes the
// contract schema (规划/04 §8.1–8.2; contracts/agent-stream.schema.json). Every integer the
// contract allows travels unchanged: amounts (*_fen, int64 = any safe integer, including 0, 1, odd
// values and values above 2^31) on a valid earnings_summary card, schema_version and quota_left
// (int32) and error codes; amounts are also compared field by field with Object.is. The property
// body returns a boolean; one summary assertion follows. Runs and seed only from @couli/testing.
import { isDeepStrictEqual } from 'node:util';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { StreamWriter } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import { frameIsValid, META, recordingSink, tryReadSse, type Line } from './kit.ts';

type Earnings = {
  withdrawable: number;
  estimated: number;
  latest: { title_key: string; amount_fen: number } | null;
  period: string | null;
  overdue: boolean;
};

type Step =
  | { kind: 'ping' }
  | { kind: 'text.delta'; delta: string }
  | { kind: 'tool.status'; phase: 'start' | 'end' | 'failed' }
  | { kind: 'card'; fallback: string; version: number }
  | { kind: 'earnings'; earnings: Earnings };

const INT32_MAX = 2 ** 31 - 1;

/** int64 amounts: edge values (0, 1, around 2^31 and 2^32, the safe-integer limits) and any safe integer. */
const fen: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(
    0,
    1,
    -1,
    3,
    INT32_MAX,
    2 ** 31,
    2 ** 31 + 1,
    2147483649,
    2 ** 32 - 1,
    2 ** 32 + 1,
    Number.MAX_SAFE_INTEGER,
    -(2 ** 31) - 1,
    Number.MIN_SAFE_INTEGER,
  ),
  fc.integer({ min: 0, max: 2 ** 20 }).map((n) => 2 * n + 1),
  fc.integer({ min: 2 ** 31 + 1, max: Number.MAX_SAFE_INTEGER }),
  fc.maxSafeInteger(),
);

const earnings: fc.Arbitrary<Earnings> = fc.record({
  withdrawable: fen,
  estimated: fen,
  latest: fc.option(
    fen.map((amount_fen) => ({ title_key: 'withdrawal_status.PENDING_REVIEW.label', amount_fen })),
    { nil: null },
  ),
  period: fc.option(
    fc
      .tuple(fc.integer({ min: 2026, max: 2099 }), fc.integer({ min: 1, max: 12 }))
      .map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`),
    { nil: null },
  ),
  overdue: fc.boolean(),
});

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ kind: 'ping' as const }),
  fc
    .string({ minLength: 1, unit: 'binary' })
    .map((delta) => ({ kind: 'text.delta' as const, delta })),
  // Multi-line text on purpose: line breaks must survive the data line unchanged.
  fc
    .array(fc.constantFrom('行', 'a', '\n', '\r', '\r\n', '\u2028', ' '), { minLength: 1 })
    .map((parts) => ({ kind: 'text.delta' as const, delta: parts.join('') })),
  fc
    .constantFrom('start', 'end', 'failed')
    .map((phase) => ({ kind: 'tool.status' as const, phase })),
  fc
    .tuple(
      fc.string({ minLength: 1 }),
      fc.oneof(fc.constant(INT32_MAX), fc.integer({ min: 1, max: INT32_MAX })),
    )
    .map(([fallback, version]) => ({ kind: 'card' as const, fallback, version })),
  earnings.map((value) => ({ kind: 'earnings' as const, earnings: value })),
);

/** contracts/agent-stream.schema.json $defs/done.finish_reason, written out by hand (all 9). */
const FINISH_REASONS = [
  'stop',
  'cancelled',
  'limit',
  'budget',
  'error',
  'auth_required',
  'safety',
  'fallback',
  'timeout',
] as const;
type Reason = (typeof FINISH_REASONS)[number];

type Terminal =
  | { kind: 'done'; finish_reason: Reason; quota_left: number }
  | { kind: 'error'; code: number; retryable: boolean; fallback: string | null };

const terminal: fc.Arbitrary<Terminal> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(...FINISH_REASONS),
      fc.oneof(fc.constantFrom(0, 1, INT32_MAX), fc.integer({ min: 0, max: INT32_MAX })),
    )
    .map(([finish_reason, quota_left]) => ({ kind: 'done' as const, finish_reason, quota_left })),
  fc
    .record({
      code: fc.oneof(fc.constantFrom(10000, 50302, 99999), fc.integer({ min: 10000, max: 99999 })),
      retryable: fc.boolean(),
      fallback: fc.option(fc.constant('search_page'), { nil: null }),
    })
    .map((value) => ({ kind: 'error' as const, ...value })),
);

const TOOL = { tool: 'search_products', display_text: '查询' } as const;

/** A fresh card input for a step (called separately for the expectation and for the writer). */
function cardOf(item: Extract<Step, { kind: 'card' | 'earnings' }>, cardId: string) {
  if (item.kind === 'card')
    return {
      card_id: cardId,
      type: 'future_card',
      schema_version: item.version,
      data: {},
      fallback_text: item.fallback,
    };
  const e = item.earnings;
  return {
    card_id: cardId,
    type: 'earnings_summary',
    schema_version: 1,
    data: {
      as_of: '2026-10-06T10:00:00+08:00',
      withdrawable_fen: e.withdrawable,
      estimated_total_fen: e.estimated,
      next_credit_period: e.period,
      credit_overdue: e.overdue,
      latest_withdrawal: e.latest === null ? null : { ...e.latest },
      actions: [
        { route: 'Wallet', text_key: 'agent.earnings.open_wallet' },
        { route: 'WithdrawRecords', text_key: 'agent.earnings.open_records' },
      ],
    },
    fallback_text: '请到钱包页查看收益与提现进度。',
  };
}

function terminalOf(end: Terminal) {
  return end.kind === 'done'
    ? { finish_reason: end.finish_reason, quota_left: end.quota_left }
    : { code: end.code, msg: 'AI 暂不可用', retryable: end.retryable, fallback: end.fallback };
}

/** Plain JSON copy, so a frame object of any prototype compares by content only. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Each amount of an earnings card, read from a frame's data, equals the generated value exactly. */
function amountsKept(frameData: unknown, e: Earnings): boolean {
  if (typeof frameData !== 'object' || frameData === null) return false;
  const card = (frameData as { data?: Record<string, unknown> }).data;
  if (card === undefined) return false;
  const latest = card['latest_withdrawal'] as { amount_fen?: unknown } | null | undefined;
  return (
    Object.is(card['withdrawable_fen'], e.withdrawable) &&
    Object.is(card['estimated_total_fen'], e.estimated) &&
    (e.latest === null ? latest === null : Object.is(latest?.amount_fen, e.latest.amount_fen))
  );
}

function holds(steps: Step[], end: Terminal): boolean {
  // Expected lines, built only from the steps: seq counted here, values copied verbatim.
  const expected: Line[] = [{ event: 'meta', id: 1, data: { ...META } }];
  let seq = 1;
  let cards = 0;
  for (const item of steps) {
    if (item.kind === 'ping') {
      expected.push({ comment: 'ping' });
      continue;
    }
    seq += 1;
    if (item.kind === 'text.delta')
      expected.push({ event: 'text.delta', id: seq, data: { seq, delta: item.delta } });
    else if (item.kind === 'tool.status')
      expected.push({ event: 'tool.status', id: seq, data: { seq, ...TOOL, phase: item.phase } });
    else {
      cards += 1;
      expected.push({ event: 'card', id: seq, data: { seq, ...cardOf(item, `c${cards}`) } });
    }
  }
  seq += 1;
  expected.push({ event: end.kind, id: seq, data: terminalOf(end) });
  const expectedFrames = expected.filter((line) => !('comment' in line));

  // Drive the writer with fresh inputs (no seq).
  const sink = recordingSink();
  const writer = new StreamWriter({ sink });
  const returned: { id: number; data: unknown }[] = [writer.emit('meta', META)];
  const amountChecks: { id: number; earnings: Earnings }[] = [];
  cards = 0;
  for (const item of steps) {
    if (item.kind === 'ping') writer.ping();
    else if (item.kind === 'text.delta')
      returned.push(writer.emit('text.delta', { delta: item.delta }));
    else if (item.kind === 'tool.status')
      returned.push(writer.emit('tool.status', { ...TOOL, phase: item.phase }));
    else {
      cards += 1;
      const frame = writer.emit('card', cardOf(item, `c${cards}`));
      returned.push(frame);
      if (item.kind === 'earnings') amountChecks.push({ id: frame.id, earnings: item.earnings });
    }
  }
  returned.push(
    end.kind === 'done'
      ? writer.emit('done', { finish_reason: end.finish_reason, quota_left: end.quota_left })
      : writer.emit('error', {
          code: end.code,
          msg: 'AI 暂不可用',
          retryable: end.retryable,
          fallback: end.fallback,
        }),
  );

  const read = tryReadSse(sink.chunks.join(''));
  if (read === undefined) return false;
  if (!isDeepStrictEqual(plain(read), plain(expected))) return false;
  if (!isDeepStrictEqual(plain(returned), plain(expectedFrames))) return false;
  for (const check of amountChecks) {
    const sent = read.find((line) => 'id' in line && line.id === check.id);
    const back = returned.find((frame) => frame.id === check.id);
    if (sent === undefined || !('data' in sent) || back === undefined) return false;
    if (!amountsKept(sent.data, check.earnings) || !amountsKept(back.data, check.earnings))
      return false;
  }
  const ids = expectedFrames.map((frame) => ('id' in frame ? frame.id : 0));
  if (
    !isDeepStrictEqual(
      ids,
      ids.map((_, index) => index + 1),
    )
  )
    return false;
  const terminals = read.filter(
    (line) => 'event' in line && (line.event === 'done' || line.event === 'error'),
  );
  if (terminals.length !== 1 || read.at(-1) !== terminals[0]) return false;
  if (!read.every((line) => 'comment' in line || frameIsValid(line))) return false;
  return writer.closed;
}

it('[04 §8.1 seq / 唯一终止事件 / 逐帧校验] 任意帧序列：返回帧与读回的 SSE 都等于按步骤独立构造的期望（含多行 delta、ping 位置、超过 2^31 的金额与 int32 上限）、id 连续、终止帧唯一且在最后、每帧过 schema', () => {
  const details = fc.check(
    fc.property(fc.array(step, { maxLength: 30 }), terminal, holds),
    propParams(),
  );
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  // PROP_RUNS runs of up to 30 frames each, every frame schema-validated twice: about 13 s at the
  // default 10,000 runs and over 2 minutes at the 100,000-run CI tier (CI #198, 2026-10-06).
}, 900_000);

it('[04 §8.3 earnings_summary 金额] 金额 2147483649、2^53−1、0、1、奇数逐字段原样写出（不按 32 位截断）', () => {
  const cases: Earnings[] = [
    {
      withdrawable: 2147483649,
      estimated: 2147483649,
      latest: { title_key: 'withdrawal_status.PENDING_REVIEW.label', amount_fen: 2147483649 },
      period: '2026-11',
      overdue: false,
    },
    {
      withdrawable: Number.MAX_SAFE_INTEGER,
      estimated: 0,
      latest: null,
      period: null,
      overdue: true,
    },
    {
      withdrawable: 1,
      estimated: 4294967297,
      latest: { title_key: 'withdrawal_status.PENDING_REVIEW.label', amount_fen: 12345 },
      period: '2027-01',
      overdue: false,
    },
  ];
  for (const e of cases) {
    const sink = recordingSink();
    const writer = new StreamWriter({ sink });
    writer.emit('meta', META);
    const frame = writer.emit('card', cardOf({ kind: 'earnings', earnings: e }, 'c1'));
    const sent = tryReadSse(sink.chunks.join(''))?.[1];
    expect(sent && 'data' in sent && amountsKept(sent.data, e), JSON.stringify(e)).toBe(true);
    expect(amountsKept(frame.data, e), JSON.stringify(e)).toBe(true);
    expect(frameIsValid(sent)).toBe(true);
  }
});

for (const reason of FINISH_REASONS) {
  it(`[04 §8.2 done.finish_reason=${reason}] 契约 9 种结束原因都能写出：读回原值、过 schema、终止帧唯一、流关闭`, () => {
    const sink = recordingSink();
    const writer = new StreamWriter({ sink });
    writer.emit('meta', { ...META });
    writer.emit('text.delta', { delta: '已为你查询' });
    const frame = writer.emit('done', { finish_reason: reason, quota_left: 7 });
    const expected = { event: 'done', id: 3, data: { finish_reason: reason, quota_left: 7 } };
    expect(frame).toEqual(expected);
    const read = tryReadSse(sink.chunks.join(''));
    expect(read).toHaveLength(3);
    expect(read?.at(-1)).toEqual(expected);
    expect(frameIsValid(read?.at(-1))).toBe(true);
    expect(read?.filter((line) => 'event' in line && line.event === 'done')).toHaveLength(1);
    expect(writer.closed).toBe(true);
  });
}
