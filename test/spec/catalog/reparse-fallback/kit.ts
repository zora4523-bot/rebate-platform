// B1-05y rule-test kit (BR-PROD-05 重新解析步骤 1、2、3 and 结果分类). The re-parse fixture of B1-05w
// over a stale product_refs row that carries a canonical_url, so every re-parse starts at step ①,
// and a union whose resolveLink is not implemented. Synthetic data only. Importing
// @couli/db/testing is the *.int.test.ts files' part: neither this kit nor what it reads does.
import { setTimeout as delay } from 'node:timers/promises';
import type { ProductRef } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import {
  UnionError,
  type Platform,
  type UnionAdapter,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  CANONICAL_URL,
  onePage,
  reparseFixture,
  type ReparseSetup,
} from '../detail-reparse/kit.ts';

export function unimplemented(platform: Platform = 'taobao'): UnionError {
  return new UnionError('adapter_unimplemented', 'synthetic: not implemented', platform);
}

export type LinkedSetup = Omit<ReparseSetup, 'stored'> & {
  readonly stored?: Partial<ProductRef>;
};

/** A stale row with a canonical_url; resolveLink stays the fake's until a case changes it. */
export function linkedFixture(setup: LinkedSetup = {}) {
  return reparseFixture({ ...setup, stored: { ...setup.stored, canonicalUrl: CANONICAL_URL } });
}

/** The same row on a platform whose resolveLink is not implemented. */
export function unimplementedLinkFixture(setup: LinkedSetup = {}) {
  const f = linkedFixture(setup);
  f.resolveLink.mockRejectedValue(unimplemented(setup.stored?.platform));
  return f;
}

/** resolveLink says it is not implemented only after `ms`: the 3 s are running by then. */
export function slowlyUnimplemented(ms: number): UnionAdapter['resolveLink'] {
  return async () => {
    await delay(ms);
    throw unimplemented();
  };
}

/** The title search finds the target after `ms`. */
export function slowPage(ms: number): UnionAdapter['searchItems'] {
  return async () => {
    await delay(ms);
    return onePage();
  };
}
