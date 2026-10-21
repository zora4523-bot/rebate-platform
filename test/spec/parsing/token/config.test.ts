import { afterEach, expect, it, vi } from 'vitest';
import { parseToken } from '../../../../apps/api/src/modules/parsing/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { contextFor, CTX, expectParsingError, fixture, observed, TOKEN } from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it.each([false, 'false', 'off'])(
  '[AC-B3-04h-SWITCH#1] 口令开关%s时抛30132，任何联盟调用之前停止',
  async (value) => {
    const f = fixture();
    f.config.set('parse.tpwd.enabled', value);
    const result = await observed(() => parseToken(f.options, TOKEN, CTX));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expectParsingError(result.error, 30132);
    expect(f.configValue.mock.calls).toEqual([[CTX.appId, 'parse.tpwd.enabled']]);
    expect(f.getGovernedAdapter).not.toHaveBeenCalled();
    expect(f.resolveLink).not.toHaveBeenCalled();
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.options.catalog.listPlatforms).not.toHaveBeenCalled();
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it.each([true, 'true', 'on', null])(
  '[AC-B3-04h-SWITCH#2] 口令开关%s沿用parseInput的启用口径',
  async (value) => {
    const f = fixture();
    if (value === null) f.config.delete('parse.tpwd.enabled');
    else f.config.set('parse.tpwd.enabled', value);
    const result = await parseToken(f.options, TOKEN, CTX);
    expect(result.ref.productKey).toBe('tb:001');
    expect(f.configValue).toHaveBeenCalledWith(CTX.appId, 'parse.tpwd.enabled');
    expect(f.resolveLink).toHaveBeenCalledTimes(1);
    expect(f.getItem).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B3-04h-SWITCH#3] 配置按context.appId读取，关闭与重新开启不沿用别的应用或旧值', async () => {
  const f = fixture();
  const enabled = new Map([
    ['synthetic-app-a', true],
    ['synthetic-app-b', false],
  ]);
  f.configValue.mockImplementation(async (appId, key) => {
    if (key !== 'parse.tpwd.enabled') throw new Error('unexpected config key');
    return { value: enabled.get(appId) ?? false, version: 1 };
  });
  const ctxA = contextFor('synthetic-app-a');
  const ctxB = contextFor('synthetic-app-b');
  expect((await parseToken(f.options, TOKEN, ctxA)).ref.appId).toBe(ctxA.appId);
  const disabled = await observed(() => parseToken(f.options, TOKEN, ctxB));
  expect(disabled.outcome).toBe('rejected');
  if (disabled.outcome === 'rejected') expectParsingError(disabled.error, 30132);
  expect(f.resolveLink).toHaveBeenCalledTimes(1);
  enabled.set(ctxB.appId, true);
  expect((await parseToken(f.options, TOKEN, ctxB)).ref.appId).toBe(ctxB.appId);
  enabled.set(ctxA.appId, false);
  const closed = await observed(() => parseToken(f.options, TOKEN, ctxA));
  expect(closed.outcome).toBe('rejected');
  if (closed.outcome === 'rejected') expectParsingError(closed.error, 30132);
  expect(f.resolveLink.mock.calls).toEqual([
    [TOKEN, ctxA],
    [TOKEN, ctxB],
  ]);
  expect(f.configValue.mock.calls).toEqual([
    [ctxA.appId, 'parse.tpwd.enabled'],
    [ctxB.appId, 'parse.tpwd.enabled'],
    [ctxB.appId, 'parse.tpwd.enabled'],
    [ctxA.appId, 'parse.tpwd.enabled'],
  ]);
});

it.each(['success', 'link_unrecognized', 'adapter_unimplemented'] as const)(
  '[AC-B3-04h-OFFICIAL#1] 官方解析%s也不读取或使用第三方开关，不发起额外HTTP请求',
  async (outcome) => {
    const f = fixture();
    f.config.set('parse.third_party.enabled', true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
    if (outcome !== 'success') {
      f.resolveLink.mockRejectedValue(
        new UnionError(outcome, 'synthetic official refusal', 'taobao'),
      );
    }
    const result = await observed(() => parseToken(f.options, TOKEN, CTX));
    if (outcome === 'success') {
      expect(result).toMatchObject({
        outcome: 'returned',
        value: { ref: { productKey: 'tb:001' } },
      });
    } else {
      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') expectParsingError(result.error, 30132);
      expect(f.getItem).not.toHaveBeenCalled();
    }
    expect(f.configValue.mock.calls).toEqual([[CTX.appId, 'parse.tpwd.enabled']]);
    expect(f.getGovernedAdapter.mock.calls).toEqual([['taobao']]);
    expect(f.resolveLink).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.searchItems).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);
