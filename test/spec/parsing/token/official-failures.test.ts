import { afterEach, expect, it, vi } from 'vitest';
import { createParsing, parseToken } from '../../../../apps/api/src/modules/parsing/index.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { CTX, expectParsingError, fixture, observed, TOKEN } from './kit.ts';

afterEach(() => vi.restoreAllMocks());

// Extend OFFICIAL#1 without changing the first round's protected tests.
// All errors are synthetic governed-port outcomes, not platform response recordings.
const failures = (['resolve', 'detail'] as const).flatMap((stage) => [
  ...(
    [
      'link_unrecognized',
      'adapter_unimplemented',
      'upstream_rejected',
      'invalid_dto',
      'item_unavailable',
    ] as const
  ).map((code) => ({
    stage,
    error: new UnionError(code, 'synthetic official refusal', 'taobao'),
    expectedCode: stage === 'detail' && code === 'item_unavailable' ? 30141 : 30132,
  })),
  ...(['upstream_unavailable', 'rate_limited'] as const).map((code) => ({
    stage,
    error: new UnionError(code, 'synthetic dependency failure', 'taobao'),
    expectedCode: 50301,
  })),
  ...(['timeout', 'circuit_open', 'quota_exceeded'] as const).map((code) => ({
    stage,
    error: new GovernanceError(code, 'synthetic-taobao', 'synthetic governed failure'),
    expectedCode: 50301,
  })),
]);

it.each(failures)(
  '[AC-B3-04h-OFFICIAL#2] $stage/$error.code仅报官方错误$expectedCode，与parseInput一致且不读第三方开关或请求第三方',
  async ({ stage, error, expectedCode }) => {
    function failedFixture() {
      const f = fixture();
      f.config.set('parse.third_party.enabled', true);
      if (stage === 'resolve') f.resolveLink.mockRejectedValue(error);
      else f.getItem.mockRejectedValue(error);
      return f;
    }

    const f = failedFixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
    const result = await observed(() => parseToken(f.options, TOKEN, CTX));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expectParsingError(result.error, expectedCode);
    expect(f.configValue.mock.calls).toEqual([[CTX.appId, 'parse.tpwd.enabled']]);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.getGovernedAdapter.mock.calls).toEqual([['taobao']]);
    expect(f.resolveLink.mock.calls).toEqual([[TOKEN, CTX]]);
    if (stage === 'resolve') expect(f.getItem).not.toHaveBeenCalled();
    else expect(f.getItem.mock.calls).toEqual([[f.resolvedRef, CTX]]);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.searchItems).not.toHaveBeenCalled();

    // The existing input port defines the error split, including detail-stage refusals.
    const legacy = failedFixture();
    expect(await createParsing(legacy.options).parseInput(TOKEN, CTX)).toEqual([
      {
        kind: 'error',
        hit: { platform: 'taobao', kind: 'tpwd', raw: TOKEN },
        error_code: expectedCode,
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  },
);
