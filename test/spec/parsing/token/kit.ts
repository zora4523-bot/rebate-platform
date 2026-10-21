import { expect, vi } from 'vitest';
import type { ParsingOptions } from '../../../../apps/api/src/modules/parsing/index.ts';
import { ParsingError } from '../../../../apps/api/src/modules/parsing/index.ts';
import type {
  CallCtx,
  RegisteredPlatform,
  UnionAdapter,
} from '../../../../apps/api/src/modules/union/index.ts';
import { fixture as coreFixture, item } from '../core/kit.ts';

export { CTX, NOW, QUOTED_AT, observed } from '../core/kit.ts';
export const TOKEN = '￥synthetic01￥';

// Synthetic domain DTOs only. Replace governance with the supplied port's test double:
// errors already describe the governed outcome, without retry timers or network traffic.
export function fixture() {
  const core = coreFixture();
  const resolvedRef = { platform: 'taobao' as const, item_id: 'synthetic-prefix-001' };
  const detail = item(resolvedRef);
  const resolveLink = vi.fn<UnionAdapter['resolveLink']>().mockResolvedValue({ item: resolvedRef });
  const getItem = vi.fn<UnionAdapter['getItem']>().mockResolvedValue(detail);
  const getGovernedAdapter = vi.fn((platform: RegisteredPlatform) => {
    void platform;
    return {
      resolveLink,
      getItem,
      convert: core.convert,
      searchItems: core.searchItems,
    };
  });
  const options: ParsingOptions = { ...core.options, getGovernedAdapter };
  return { ...core, options, resolvedRef, detail, resolveLink, getItem, getGovernedAdapter };
}

export function expectParsingError(error: unknown, code: number): void {
  expect(error).toBeInstanceOf(ParsingError);
  expect(error).toMatchObject({ code });
}

export function contextFor(appId: string): CallCtx {
  return {
    appId,
    requestId: `synthetic-request-${appId}`,
    purpose: 'online',
    signal: new AbortController().signal,
  };
}
