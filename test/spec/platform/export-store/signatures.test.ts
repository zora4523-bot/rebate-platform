import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { MemoryExportStore } from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { BASE_URL, CSV, EXPIRES, KEY, OTHER_KEY, SIGNING_KEY, fixture, memory } from './kit.ts';

it('[AC-B1-34d#7] 签名链接携带精确到毫秒的期限并使用注入密钥计算 HMAC', async () => {
  const { store, clock } = memory();
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  const expiresAt = new Date(EXPIRES);
  const result = await store.signedUrl({ key: KEY, expiresAt });
  expect(result.expiresAt.getTime()).toBe(expiresAt.getTime());
  const url = new URL(result.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${BASE_URL}/${KEY}`);
  expect(url.searchParams.get('expires')).toBe(String(expiresAt.getTime()));
  const expected = createHmac('sha256', SIGNING_KEY)
    .update(`${KEY}\n${expiresAt.getTime()}`)
    .digest('hex');
  expect(url.searchParams.get('signature')).toBe(expected);
  expect(store.verify(result.url, clock.now())).toBe(true);
  // Verification must be cryptographic, not a registry of previously issued URL strings.
  const verifier = new MemoryExportStore(fixture());
  expect(verifier.verify(result.url, clock.now())).toBe(true);
});

it('[AC-B1-34d#8] 期限前一毫秒有效，恰好到期和之后均失效', async () => {
  const { store } = memory();
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  const end = new Date(EXPIRES);
  const { url } = await store.signedUrl({ key: KEY, expiresAt: end });
  expect(store.verify(url, new Date(end.getTime() - 1))).toBe(true);
  expect(store.verify(url, end)).toBe(false);
  expect(store.verify(url, new Date(end.getTime() + 1))).toBe(false);
  expect(store.verify(url, new Date(Number.NaN))).toBe(false);
});

it('[AC-B1-34d#9] 签发只读注入时钟；过去、当前和无效期限均拒绝', async () => {
  const { store, clock } = memory();
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  const expiresAt = new Date(EXPIRES);
  expect((await store.signedUrl({ key: KEY, expiresAt })).expiresAt).toEqual(expiresAt);
  clock.set(expiresAt);
  for (const end of [expiresAt, new Date(expiresAt.getTime() - 1), new Date(Number.NaN)]) {
    await expect(
      Promise.resolve().then(() => store.signedUrl({ key: KEY, expiresAt: end })),
    ).rejects.toBeInstanceOf(Error);
  }
  const next = new Date(expiresAt.getTime() + 1);
  expect((await store.signedUrl({ key: KEY, expiresAt: next })).expiresAt).toEqual(next);
});

it('[AC-B1-34d#10] 篡改 app_id、export_id、期限、签名和来源均失效', async () => {
  const { store, clock } = memory();
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  const { url } = await store.signedUrl({ key: KEY, expiresAt: new Date(EXPIRES) });
  const expiry = new URL(url);
  expiry.searchParams.set('expires', String(new Date(EXPIRES).getTime() + 60_000));
  const signature = new URL(url);
  const original = signature.searchParams.get('signature');
  expect(original).toMatch(/^[0-9a-f]{64}$/);
  signature.searchParams.set(
    'signature',
    `${original?.startsWith('0') ? '1' : '0'}${original?.slice(1)}`,
  );
  for (const tampered of [
    url.replace(KEY, OTHER_KEY),
    url.replace('000000000001.csv', '000000000002.csv'),
    expiry.href,
    signature.href,
    url.replace('exports.example.invalid', 'attacker.invalid'),
    url.replace('https:', 'http:'),
    url.replace('/private/', '/other/'),
  ]) {
    expect(store.verify(tampered, clock.now()), tampered).toBe(false);
  }
  const wrongKey = new MemoryExportStore({ ...fixture(), signingKey: `${SIGNING_KEY}-other` });
  expect(wrongKey.verify(url, clock.now())).toBe(false);
});

it('[AC-B1-34d#11] 缺失、重复或畸形签名参数返回无效，不抛解析错误', async () => {
  const { store, clock } = memory();
  await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
  const { url } = await store.signedUrl({ key: KEY, expiresAt: new Date(EXPIRES) });
  const invalid = [
    'not a URL',
    '',
    `${BASE_URL}/${KEY}`,
    `${url}&expires=0`,
    `${url}&signature=00`,
  ];
  for (const name of ['expires', 'signature']) {
    const missing = new URL(url);
    missing.searchParams.delete(name);
    invalid.push(missing.href);
    for (const value of ['', 'NaN', 'Infinity', '-1', '1.5', 'z'.repeat(64), '0'.repeat(63)]) {
      const malformed = new URL(url);
      malformed.searchParams.set(name, value);
      invalid.push(malformed.href);
    }
  }
  for (const bad of invalid) expect(store.verify(bad, clock.now()), bad).toBe(false);
  expect(store.verify(url, clock.now())).toBe(true);
});
