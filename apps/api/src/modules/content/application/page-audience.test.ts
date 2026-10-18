import { expect, it, vi } from 'vitest';
import {
  createPageAudienceFacts,
  unionAuthorizedFrom,
  type PageAudienceReads,
} from './page-audience.ts';

function logger() {
  return { warn: vi.fn() };
}

function reads(over: Partial<PageAudienceReads> = {}): PageAudienceReads {
  return {
    unionBindingStatus: vi.fn(() => Promise.resolve('unbound')),
    orderCount: vi.fn(() => Promise.resolve(0)),
    ...over,
  };
}

const ok = (value: string): PromiseSettledResult<string> => ({ status: 'fulfilled', value });
const failed: PromiseSettledResult<string> = { status: 'rejected', reason: new Error('down') };

it('[AC-F1-09g#u3] union_authorized: any active wins; a failure with no active is unknown', () => {
  expect(unionAuthorizedFrom([ok('active'), failed])).toBe(true);
  expect(unionAuthorizedFrom([failed, ok('active')])).toBe(true);
  expect(unionAuthorizedFrom([ok('pending_auth'), failed])).toBeNull();
  expect(unionAuthorizedFrom([failed, failed])).toBeNull();
  expect(unionAuthorizedFrom([ok('pending_auth'), ok('released')])).toBe(false);
  expect(unionAuthorizedFrom([ok('unbound'), ok('active')])).toBe(true);
});

it('[AC-F1-09g#u4] reads both platforms and the order count once, scoped to the user', async () => {
  const r = reads({
    unionBindingStatus: vi.fn((_a: string, _u: string, platform: string) =>
      Promise.resolve(platform === 'pdd' ? 'active' : 'invalid'),
    ),
    orderCount: vi.fn(() => Promise.resolve(2)),
  });
  const facts = await createPageAudienceFacts({ reads: r, logger: logger() }).facts('a', 'u');
  expect(facts).toEqual({ hasParent: null, unionAuthorized: true, hasOrder: true });
  expect(r.unionBindingStatus).toHaveBeenCalledTimes(2);
  expect(r.unionBindingStatus).toHaveBeenCalledWith('a', 'u', 'taobao');
  expect(r.unionBindingStatus).toHaveBeenCalledWith('a', 'u', 'pdd');
  expect(r.orderCount).toHaveBeenCalledExactlyOnceWith('a', 'u');
});

it('[AC-F1-09g#u5] a failed read makes only that fact unknown and warns', async () => {
  const log = logger();
  const r = reads({
    unionBindingStatus: vi.fn((_a: string, _u: string, platform: string) =>
      platform === 'taobao' ? Promise.reject(new Error('down')) : Promise.resolve('unbound'),
    ),
    orderCount: () => {
      throw new Error('sync failure');
    },
  });
  const facts = await createPageAudienceFacts({ reads: r, logger: log }).facts('a', 'u');
  expect(facts).toEqual({ hasParent: null, unionAuthorized: null, hasOrder: null });
  expect(log.warn).toHaveBeenCalledTimes(2);
});

it('[AC-F1-09g#u6] only needed facts are read; no reads port → all unknown', async () => {
  const r = reads({ orderCount: vi.fn(() => Promise.resolve(0)) });
  const facts = await createPageAudienceFacts({ reads: r, logger: logger() }).facts(
    'a',
    'u',
    new Set(['hasOrder'] as const),
  );
  expect(facts).toEqual({ hasParent: null, unionAuthorized: null, hasOrder: false });
  expect(r.unionBindingStatus).not.toHaveBeenCalled();
  expect(await createPageAudienceFacts({ reads: null, logger: logger() }).facts('a', 'u')).toEqual({
    hasParent: null,
    unionAuthorized: null,
    hasOrder: null,
  });
});

it('[AC-F1-09g#u7] has_parent is read when a port is supplied', async () => {
  const r = reads({ hasParent: () => Promise.resolve(true) });
  const facts = await createPageAudienceFacts({ reads: r, logger: logger() }).facts(
    'a',
    'u',
    new Set(['hasParent'] as const),
  );
  expect(facts.hasParent).toBe(true);
});

it('[AC-F1-09j#u1] has_parent true / false pass through; a failed parent read is unknown and warns once', async () => {
  for (const value of [true, false]) {
    const hasParent = vi.fn(() => Promise.resolve(value));
    const facts = await createPageAudienceFacts({
      reads: reads({ hasParent }),
      logger: logger(),
    }).facts('a', 'u');
    expect(facts.hasParent).toBe(value);
    expect(hasParent).toHaveBeenCalledExactlyOnceWith('a', 'u');
  }
  const log = logger();
  const facts = await createPageAudienceFacts({
    reads: reads({
      hasParent: () => Promise.reject(new Error('down')),
      orderCount: () => Promise.resolve(3),
    }),
    logger: log,
  }).facts('a', 'u');
  expect(facts).toEqual({ hasParent: null, unionAuthorized: false, hasOrder: true });
  expect(log.warn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      event: 'content_page_audience_unavailable',
      app_id: 'a',
      fact: 'has_parent',
    }),
    expect.any(String),
  );
});

it('[AC-F1-09j#u2] has_parent is not read when the page does not need it', async () => {
  const hasParent = vi.fn(() => Promise.resolve(true));
  const facts = await createPageAudienceFacts({
    reads: reads({ hasParent }),
    logger: logger(),
  }).facts('a', 'u', new Set(['hasOrder'] as const));
  expect(facts.hasParent).toBeNull();
  expect(hasParent).not.toHaveBeenCalled();
});
