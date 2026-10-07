import { describe, expect, it } from 'vitest';
import { noRebateProductUrl } from './link-open-conversion.ts';
import { openHttpResult } from './link-open.ts';
import { jumpUsable, openRequestBody, type LinkOpenJump } from './link-open-requote.ts';

describe('linking open HTTP result', () => {
  it.each([
    [20901, 409],
    [20903, 409],
    [40901, 409],
    [20001, 400],
    [50301, 503],
    [50303, 503],
  ])('[AC-B1-06e] idempotency and open code %i keeps HTTP %i', (code, status) => {
    const result = openHttpResult({ code, data: null }, 'synthetic-trace');
    expect(result.status).toBe(status);
    expect(result.envelope).toMatchObject({ code, trace_id: 'synthetic-trace' });
  });

  it('[AC-B1-06e] 20001 names the Idempotency-Key header', () => {
    const result = openHttpResult({ code: 20001, data: null }, 'synthetic-trace');
    expect(result.envelope.data).toEqual({ fields: ['idempotency-key'] });
  });
});

describe('linking no-rebate product page', () => {
  it('[AC-B1-06e] default item-mode jd key uses the re-check sku, without promotion parameters', () => {
    const url = new URL(
      noRebateProductUrl('jd:i_AbC123', { platform: 'jd', skuId: '100012043978' }),
    );
    expect(url.href).toBe('https://item.jd.com/100012043978.html');
  });

  it.each([
    [undefined],
    [{ platform: 'jd' as const, skuId: null }],
    [{ platform: 'jd' as const, skuId: '12?pid=untrusted' }],
    [{ platform: 'pdd' as const, skuId: '123' }],
  ])('[AC-B1-06e] item-mode jd key without a numeric jd sku has no page (%o)', (item) => {
    expect(() => noRebateProductUrl('jd:i_AbC123', item)).toThrow(Error);
  });

  it('[AC-B1-06e] a numeric key still wins over the item sku', () => {
    expect(noRebateProductUrl('jd:12345', { platform: 'jd', skuId: '999' })).toBe(
      'https://item.jd.com/12345.html',
    );
  });
});

describe('linking open single-flight conversion reuse (B1-06m)', () => {
  const jump: LinkOpenJump = {
    primary: { type: 'h5', value: 'https://example.test/synthetic-rebate' },
    fallbacks: [],
    expire_at: '2031-05-06T07:23:09.000Z',
  };
  const expireMs = Date.parse(jump.expire_at);

  it('[AC-B1-06m] a shared jump opened before its expire_at is reused, at or after it is not', () => {
    expect(jumpUsable(jump, expireMs - 1)).toBe(true);
    expect(jumpUsable(jump, expireMs)).toBe(false);
    expect(jumpUsable(jump, expireMs + 1)).toBe(false);
  });

  it('[AC-B1-06m] a jump without a valid expire_at is never reused', () => {
    expect(jumpUsable({ ...jump, expire_at: 'not-an-instant' }, 0)).toBe(false);
  });
});

describe('linking open idempotent request body (B1-06m)', () => {
  const base = {
    linkId: '0199a3b4-5c6d-7000-8000-000000000088',
    idempotencyKey: 'synthetic-open-1',
    traceId: 'synthetic-trace',
    client: 'ios' as const,
  };

  it('[AC-B1-06m] defaults are explicit, so an omitted and a default field are one body', () => {
    expect(openRequestBody(base)).toEqual({ installed: 'unknown', no_rebate: false });
    expect(openRequestBody({ ...base, installed: 'unknown', noRebate: false })).toEqual(
      openRequestBody(base),
    );
  });

  it.each([
    [{ noRebate: true, noRebateReason: 'auth_failed' as const }],
    [{ spm: 'detail.buy.1' }],
    [{ installed: 'true' as const }],
  ])('[AC-B1-06m] a changed contract field %o changes the body (same key → 20901)', (change) => {
    const first = { ...base, noRebate: true, noRebateReason: 'auth_declined' as const };
    expect(openRequestBody({ ...first, ...change })).not.toEqual(openRequestBody(first));
  });

  it('[AC-B1-06m] no_rebate_reason and spm are part of the body', () => {
    expect(
      openRequestBody({ ...base, noRebate: true, noRebateReason: 'auth_failed', spm: 'a.b.c' }),
    ).toEqual({
      installed: 'unknown',
      no_rebate: true,
      no_rebate_reason: 'auth_failed',
      spm: 'a.b.c',
    });
  });
});
