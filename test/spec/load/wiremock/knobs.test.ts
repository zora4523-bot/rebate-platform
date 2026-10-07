// Rule tests for the configurable delay and fault share of the QA-06b load stubs (规划/05 QA-06
// 「峰值 3 倍……P95 与错误率达标」needs upstream latency and an upstream error share the drill can
// set). 口径: a fault share of p percent means exactly p faulted answers in every 100 consecutive
// requests to one stub group, starting from a fresh import (WireMock scenario ring); the delay is
// the fixed delay of every success answer. Both are checked for defaults and for other values.
// Top-level it() only.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  buildLoadImport,
  type LoadFaultKind,
  type LoadStubMapping,
  type LoadStubOptions,
  type UnionRecordingInput,
} from '../../../../infra/load/wiremock/stubs.ts';
import {
  bailianProbe,
  firstTurnBody,
  fixtureRecordings,
  isFault,
  unionProbe,
  wiremock,
  type Probe,
} from './kit.ts';

function taobao(): UnionRecordingInput {
  return fixtureRecordings().find((r) => r.platform === 'taobao') as UnionRecordingInput;
}

/** Answers to `n` identical requests against a fresh import; null / ambiguous become strings. */
function answers(options: LoadStubOptions, probe: Probe, n: number): (LoadStubMapping | string)[] {
  const serve = wiremock(buildLoadImport([taobao()], options).mappings);
  return Array.from({ length: n }, () => {
    const hit = serve(probe);
    return hit === null ? 'unmatched' : hit;
  });
}

function faults(list: readonly (LoadStubMapping | string)[]): number {
  return list.filter((a) => typeof a !== 'string' && isFault(a)).length;
}

function unmatched(list: readonly (LoadStubMapping | string)[]): number {
  return list.filter((a) => typeof a === 'string').length;
}

it('[规划/05 QA-06 默认值] 不配置时：联盟与百炼 100 次请求全部正常应答，没有故障，成功应答不延迟', () => {
  for (const probe of [unionProbe(taobao()), bailianProbe(firstTurnBody())]) {
    const list = answers({}, probe, 100);
    const delays = list.map((a) =>
      typeof a === 'string' ? a : (a.response.fixedDelayMilliseconds ?? 0),
    );
    expect({
      unmatched: unmatched(list),
      faults: faults(list),
      delayed: delays.filter((d) => d !== 0),
    }).toEqual({
      unmatched: 0,
      faults: 0,
      delayed: [],
    });
  }
});

it('[规划/05 QA-06 故障比例] faultPercent 取 0～100 的每个整数：联盟与百炼每 100 次连续请求恰有该数目的故障，其余都是正常应答', () => {
  const wrong: string[] = [];
  for (let p = 0; p <= 100; p += 1) {
    for (const [label, probe] of [
      ['union', unionProbe(taobao())],
      ['bailian', bailianProbe(firstTurnBody())],
    ] as const) {
      const list = answers({ faultPercent: p }, probe, 200);
      const got = [faults(list.slice(0, 100)), faults(list.slice(100)), unmatched(list)];
      if (got.join() !== `${String(p)},${String(p)},0`)
        wrong.push(`${label} p=${String(p)} got ${got.join()}`);
    }
  }
  expect(wrong).toEqual([]);
  // 编排者 2026-10-07：101 档 × 100 次请求在 CI 约 8 秒，超过 Vitest 默认 5 秒；只加显式超时，不改断言与次数（decision 31）。
}, 120_000);

it('[规划/05 QA-06 故障种类] 默认故障是 5xx；换成 rate_limited 是 429，connection_reset 是连接重置；故障应答都不带响应体', () => {
  const kinds = (options: LoadStubOptions) =>
    answers({ faultPercent: 100, ...options }, unionProbe(taobao()), 3).map((a) =>
      typeof a === 'string'
        ? a
        : {
            kind:
              a.response.fault ??
              (a.response.status !== undefined && a.response.status >= 500
                ? '5xx'
                : a.response.status),
            body: a.response.body ?? '',
          },
    );
  const row = (kind: string | number) => [1, 2, 3].map(() => ({ kind, body: '' }));
  expect({
    byDefault: kinds({}),
    serverError: kinds({ faultKind: 'server_error' }),
    rateLimited: kinds({ faultKind: 'rate_limited' }),
    reset: kinds({ faultKind: 'connection_reset' }),
  }).toEqual({
    byDefault: row('5xx'),
    serverError: row('5xx'),
    rateLimited: row(429),
    reset: row('CONNECTION_RESET_BY_PEER'),
  });
});

it('[规划/05 QA-06 延迟] delayMs 取 [0, 60000] 内任意整数：联盟与百炼的每个成功应答都按该值固定延迟', () => {
  let passes = 0;
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 60_000 }),
      fc.integer({ min: 0, max: 100 }),
      (delay, p) => {
        const { mappings } = buildLoadImport([taobao()], { delayMs: delay, faultPercent: p });
        const success = mappings.filter((m) => !isFault(m));
        const ok =
          success.length > 0 &&
          success.every((m) => (m.response.fixedDelayMilliseconds ?? 0) === delay);
        if (ok) passes += 1;
        return ok;
      },
    ),
    propParams(),
  );
  expect(passes).toBe(propParams().numRuns);
}, 900_000);

/** 'built' when accepted, 'not-implemented' for the skeleton, 'rejected' for a real validation error. */
function attempt(options: LoadStubOptions): 'built' | 'not-implemented' | 'rejected' {
  try {
    buildLoadImport([taobao()], options);
    return 'built';
  } catch (e) {
    return String(e).includes('NotImplemented') ? 'not-implemented' : 'rejected';
  }
}

const BAD_OPTIONS: readonly [string, LoadStubOptions][] = [
  ['delayMs=-1', { delayMs: -1 }],
  ['delayMs=60001', { delayMs: 60_001 }],
  ['delayMs=0.5', { delayMs: 0.5 }],
  ['delayMs=NaN', { delayMs: Number.NaN }],
  ['faultPercent=-1', { faultPercent: -1 }],
  ['faultPercent=101', { faultPercent: 101 }],
  ['faultPercent=12.5', { faultPercent: 12.5 }],
  ['faultPercent=Infinity', { faultPercent: Number.POSITIVE_INFINITY }],
  ['faultKind=boom', { faultKind: 'boom' as unknown as LoadFaultKind }],
];

it.each(BAD_OPTIONS)(
  '[规划/05 QA-06 参数校验] %s：超出范围或非整数的 delayMs / faultPercent、未知 faultKind 被拒绝，不悄悄改成默认值',
  (_label: string, options: LoadStubOptions) => {
    expect(attempt(options)).toBe('rejected');
  },
);

it('[规划/05 QA-06 参数校验] 边界值 delayMs=0/60000、faultPercent=0/100 与三种 faultKind 都被接受', () => {
  const ok: LoadStubOptions[] = [
    { delayMs: 0 },
    { delayMs: 60_000 },
    { faultPercent: 0 },
    { faultPercent: 100 },
    { faultKind: 'server_error' },
    { faultKind: 'rate_limited' },
    { faultKind: 'connection_reset' },
  ];
  expect(ok.map(attempt)).toEqual(ok.map(() => 'built'));
});
