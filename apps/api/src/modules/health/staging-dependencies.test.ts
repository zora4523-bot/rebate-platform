import { expect, it } from 'vitest';
import { checkStagingDependencies, pgConnectionString } from './staging-dependencies.ts';

// Synthetic URLs only; nothing here connects anywhere.
it('[AC-B1-01zzj-DEPS#7] verify-ca 连接串原样保留口令，只追加 libpq 兼容参数', () => {
  // Assembled at run time so no literal credential URL sits in the source.
  const userInfo = ['couli_app', 'synthetic%2Fpw'].join(':');
  const url = `postgres://${userInfo}@10.0.0.5:5433/staging?sslmode=verify-ca&sslrootcert=/etc/pki/ca.crt`;
  const result = pgConnectionString(url);
  expect(result).toBe(`${url}&uselibpqcompat=true`);
  const parsed = new URL(result ?? '');
  expect(parsed.password).toBe('synthetic%2Fpw');
  expect(parsed.searchParams.get('sslmode')).toBe('verify-ca');
});

it('[AC-B1-01zzj-DEPS#7] 没有 sslmode 或已带兼容参数时不改连接串', () => {
  const plain = 'postgres://couli_app@database.invalid:5433/staging';
  expect(pgConnectionString(plain)).toBe(plain);
  const compat = `${plain}?sslmode=verify-ca&uselibpqcompat=true`;
  expect(pgConnectionString(compat)).toBe(compat);
});

it('[AC-B1-01zzj-DEPS#4] 非 postgres 地址、缺主机或角色的连接串被拒绝', () => {
  expect(pgConnectionString('not a url')).toBeNull();
  expect(pgConnectionString('redis://cache.invalid:6379/0')).toBeNull();
  expect(pgConnectionString('postgres://database.invalid:5433/staging')).toBeNull();
});

it('[AC-B1-01zzj-DEPS#4] 连接串无效时不连接即返回不健康', async () => {
  expect(await checkStagingDependencies('payout', { databaseUrl: 'not a url' })).toBe(false);
  expect(await checkStagingDependencies('worker', { databaseUrl: '   ' })).toBe(false);
});
