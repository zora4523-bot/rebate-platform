import { expect, it, vi } from 'vitest';
import {
  createParsing,
  ParsingError,
  parseToken,
  parseUrl,
} from '../../../../apps/api/src/modules/parsing/index.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { URL_A } from '../core/kit.ts';
import { CTX, fixture, observed, TOKEN } from './kit.ts';

it.each([
  { stage: 'catalog', error: new Error('synthetic catalog database failure') },
  ...(['resolve', 'detail'] as const).flatMap((stage) => [
    {
      stage,
      error: new GovernanceError('invalid_policy', 'synthetic-taobao', 'synthetic config bug'),
    },
    { stage, error: new Error('synthetic internal adapter failure') },
  ]),
])(
  '[AC-B3-04h-ERROR#2] $stage/$error.message原样抛出，与parseUrl一致，不降级为口令业务错误',
  async ({ stage, error }) => {
    function failedFixture() {
      const f = fixture();
      if (stage === 'catalog') {
        vi.mocked(f.options.catalog.listPlatforms).mockRejectedValue(error);
      } else if (stage === 'resolve') f.resolveLink.mockRejectedValue(error);
      else f.getItem.mockRejectedValue(error);
      return f;
    }

    const f = failedFixture();
    const result = await observed(() => parseToken(f.options, TOKEN, CTX));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.error).toBe(error);
      expect(result.error).not.toBeInstanceOf(ParsingError);
    }
    expect(f.resolveLink.mock.calls).toEqual([[TOKEN, CTX]]);
    if (stage === 'catalog') expect(f.options.catalog.listPlatforms).toHaveBeenCalledTimes(1);
    if (stage === 'detail') expect(f.getItem.mock.calls).toEqual([[f.resolvedRef, CTX]]);
    else expect(f.getItem).not.toHaveBeenCalled();
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();

    const urlFixture = failedFixture();
    const urlResult = await observed(() => parseUrl(urlFixture.options, URL_A, CTX));
    expect(urlResult.outcome).toBe('rejected');
    if (urlResult.outcome === 'rejected') expect(urlResult.error).toBe(error);

    const legacy = failedFixture();
    expect(await createParsing(legacy.options).parseInput(TOKEN, CTX)).toEqual([
      { kind: 'error', hit: { platform: 'taobao', kind: 'tpwd', raw: TOKEN }, error_code: 50001 },
    ]);
  },
);
