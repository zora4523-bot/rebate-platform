import { expect, it } from 'vitest';
import { createParsing, parseToken } from '../../../../apps/api/src/modules/parsing/index.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError, type ItemRef } from '../../../../apps/api/src/modules/union/index.ts';
import { CTX, expectParsingError, fixture, observed, TOKEN } from './kit.ts';

const failures = [
  {
    stage: 'adapter',
    error: new UnionError('adapter_unimplemented', 'synthetic permission'),
    code: 30131,
  },
  ...(
    [
      'link_unrecognized',
      'adapter_unimplemented',
      'upstream_rejected',
      'invalid_dto',
      'item_unavailable',
    ] as const
  ).map((code) => ({
    stage: 'resolve',
    error: new UnionError(code, 'synthetic refusal'),
    code: 30132,
  })),
  { stage: 'detail', error: new UnionError('item_unavailable', 'synthetic delisted'), code: 30141 },
  ...(['resolve', 'detail'] as const).flatMap((stage) => [
    ...(['upstream_unavailable', 'rate_limited'] as const).map((code) => ({
      stage,
      error: new UnionError(code, 'synthetic dependency failure'),
      code: 50301,
    })),
    ...(['timeout', 'circuit_open', 'quota_exceeded'] as const).map((code) => ({
      stage,
      error: new GovernanceError(code, 'synthetic-taobao', 'synthetic governed failure'),
      code: 50301,
    })),
  ]),
];

it.each(failures)(
  '[AC-B3-04h-ERROR#1] $stage/$error.code抛ParsingError($code)，与parseInput同口令结果一致',
  async ({ stage, error, code }) => {
    function failedFixture() {
      const f = fixture();
      if (stage === 'adapter')
        f.getGovernedAdapter.mockImplementation(() => {
          throw error;
        });
      else if (stage === 'resolve') f.resolveLink.mockRejectedValue(error);
      else f.getItem.mockRejectedValue(error);
      return f;
    }
    const f = failedFixture();
    const result = await observed(() => parseToken(f.options, TOKEN, CTX));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expectParsingError(result.error, code);
    if (stage === 'adapter') expect(f.resolveLink).not.toHaveBeenCalled();
    if (stage !== 'detail') expect(f.getItem).not.toHaveBeenCalled();
    else expect(f.getItem).toHaveBeenCalledTimes(1);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.searchItems).not.toHaveBeenCalled();
    const legacy = failedFixture();
    expect(await createParsing(legacy.options).parseInput(TOKEN, CTX)).toEqual([
      { kind: 'error', hit: { platform: 'taobao', kind: 'tpwd', raw: TOKEN }, error_code: code },
    ]);
  },
);

it.each([
  ['missing', { platform: 'taobao' }],
  ['null', { platform: 'taobao', item_id: null }],
  ['empty', { platform: 'taobao', item_id: '' }],
  ['empty suffix', { platform: 'taobao', item_id: 'synthetic-' }],
  ['whitespace', { platform: 'taobao', item_id: 'synthetic- 001' }],
  ['slash', { platform: 'taobao', item_id: 'synthetic-a/b' }],
  ['question', { platform: 'taobao', item_id: 'synthetic-a?b' }],
  ['hash', { platform: 'taobao', item_id: 'synthetic-a#b' }],
  ['too long', { platform: 'taobao', item_id: 'a'.repeat(125) }],
] satisfies readonly [string, ItemRef][])(
  '[AC-B3-04h-KEY#2] 商品键不可派生%s时抛30131，不能转义、截短或猜测ID',
  async (_name, ref) => {
    const f = fixture();
    f.resolveLink.mockResolvedValue({ item: ref });
    const result = await observed(() => parseToken(f.options, TOKEN, CTX));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expectParsingError(result.error, 30131);
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);
