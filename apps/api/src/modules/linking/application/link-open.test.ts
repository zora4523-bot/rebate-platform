import { describe, expect, it } from 'vitest';
import { noRebateProductUrl } from './link-open-conversion.ts';
import { openHttpResult } from './link-open.ts';

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
