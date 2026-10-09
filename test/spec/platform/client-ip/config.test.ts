import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';

it.each([undefined, ''])('[AC-B1-03m#1] TRUSTED_PROXIES=%s 解析为空数组', (value) => {
  expect(loadConfig({ APP_ENV: 'test', TRUSTED_PROXIES: value })).toHaveProperty(
    'trustedProxies',
    [],
  );
});

it.each([
  ['198.51.100.10', ['198.51.100.10']],
  ['2001:db8::10', ['2001:db8::10']],
  ['198.51.100.0/24', ['198.51.100.0/24']],
  ['2001:db8::/32', ['2001:db8::/32']],
  [
    ' 198.51.100.10/32 ,\t2001:db8::10/128 , 192.0.2.0/24 ',
    ['198.51.100.10/32', '2001:db8::10/128', '192.0.2.0/24'],
  ],
  ['128.0.0.0/1,8000::/1', ['128.0.0.0/1', '8000::/1']],
] as const)('[AC-B1-03m#2] 合法地址、前缀边界和项两侧空白：%s', (value, expected) => {
  expect(loadConfig({ APP_ENV: 'test', TRUSTED_PROXIES: value })).toHaveProperty(
    'trustedProxies',
    expected,
  );
});

it.each([
  'true',
  'false',
  '*',
  '0',
  '1',
  '2',
  '-1',
  '0.0.0.0/0',
  '::/0',
  'loopback',
  'linklocal',
  'uniquelocal',
  '198.51.100.0/255.255.255.0',
  '2001:db8::/ffff:ffff::',
  '198.51.100.10,,192.0.2.10',
  ',198.51.100.10',
  '198.51.100.10,',
  '198.51.100.10, ,192.0.2.10',
  'not-an-ip',
  '198.51.100.10,not-an-ip',
  '198.51.100.999',
  '2001:db8::xyz',
  '198.51.100.0/33',
  '2001:db8::/129',
  '198.51.100.0/-1',
  '198.51.100.0/1.5',
  '198.51.100.0/',
  '198.51.100.10:8080',
])('[AC-B1-03m#6] 非法代理配置 %s 启动失败且错误不回显取值', (value) => {
  let failure: unknown;
  try {
    loadConfig({ APP_ENV: 'test', TRUSTED_PROXIES: value });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigError);
  const error = failure as ConfigError;
  expect(error.problems.some((problem) => problem.startsWith('TRUSTED_PROXIES:'))).toBe(true);
  expect(error.problems.join('\n')).not.toContain(value);
  expect(error.message).not.toContain(value);
});

it('[AC-B1-03m#6] 与其他配置错误合并报告，不吞掉可信代理的错误', () => {
  let failure: unknown;
  try {
    loadConfig({ APP_ENV: 'test', API_PORT: 'bad-port', TRUSTED_PROXIES: 'bad-proxy' });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigError);
  const error = failure as ConfigError;
  expect(error.problems.some((problem) => problem.startsWith('API_PORT:'))).toBe(true);
  expect(error.problems.some((problem) => problem.startsWith('TRUSTED_PROXIES:'))).toBe(true);
  expect(error.message).not.toContain('bad-port');
  expect(error.message).not.toContain('bad-proxy');
});
