// B1-22d: the admin entry gets the fake site OAuth only in local / test; elsewhere no provider,
// announced once without any secret. The session audit rows take the contract's action names.
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { reauthAuditWriter } from '../application/admin-accounts.ts';
import type { UnionAuditInput } from '../pids/service.ts';
import { createSiteOAuthProviders } from './fake-site-oauth.ts';

const clock = new FixedClock('2026-10-09T02:00:00.000Z');

function recorder() {
  const lines: unknown[][] = [];
  return { lines, logger: { warn: (...args: unknown[]) => void lines.push(args) } };
}

it('[B1-22d][BR-ID-24] local / test 装配三个平台的假授权，不打日志', () => {
  for (const appEnv of ['local', 'test']) {
    const { lines, logger } = recorder();
    const providers = createSiteOAuthProviders(appEnv, clock, logger as never);
    expect(Object.keys(providers).sort()).toEqual(['jd', 'pdd', 'taobao']);
    expect(lines).toEqual([]);
  }
});

it('[B1-22d][BR-ID-24] staging / prod 不装假实现，只打一条 union_site_oauth_unconfigured', () => {
  for (const appEnv of ['staging', 'prod']) {
    const { lines, logger } = recorder();
    expect(createSiteOAuthProviders(appEnv, clock, logger as never)).toEqual({});
    expect(lines).toEqual([[{ app_env: appEnv }, 'union_site_oauth_unconfigured']]);
  }
});

it('[B1-22d][BR-ID-24] 会话审计按契约改名，其余动作原样', async () => {
  const written: UnionAuditInput[] = [];
  const writer = reauthAuditWriter(() => ({
    append: (input) => {
      written.push(input);
      return Promise.resolve();
    },
  }));
  const base = { appId: 'couli', actor: 'a', target: 't', before: null, after: null, ip: null };
  const bound = writer(undefined as never);
  for (const action of ['union.reauth_start', 'union.reauth_succeeded', 'union_other']) {
    await bound.append({ ...base, action });
  }
  expect(written.map((input) => input.action)).toEqual([
    'union_account_reauthorize_start',
    'union_account_reauthorize',
    'union_other',
  ]);
});
