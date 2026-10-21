import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { MediaStoreUnavailableError, type MaterialChannelsSpec } from '../../platform/index.ts';
import type { ClientConfig } from '../domain/client-config.ts';
import {
  ClientConfigService,
  ClientConfigUnavailableError,
  type ClientConfigDeps,
} from './client-config.ts';
import type { ContentReader } from './content-reader.ts';
import type { InviteRewardBudgetReader } from './invite-reward-budget-reader.ts';

const REQUIRED: Record<string, unknown> = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};

function service(
  values: Record<string, unknown>,
  failure?: Error,
  platformIcons: ClientConfigDeps['platformIcons'] = () => Promise.resolve({}),
  channels: MaterialChannelsSpec = { version: 'empty', channels: [] },
) {
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  const apps = new Set<string>();
  const reader: ContentReader = {
    appVersion: () => Promise.resolve(null),
    minSupportedVersion: () => Promise.resolve(null),
    configValue: (appId, key) => {
      apps.add(appId);
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(
        Object.hasOwn(values, key) ? { value: values[key] as never, version: 1 } : null,
      );
    },
  };
  const svc = new ClientConfigService({
    reader,
    platformIcons,
    linkPatterns: () =>
      ({ version: 'lp', rules: [] }) as NonNullable<ClientConfig['link_patterns']>,
    materialChannels: () => channels,
    logger: {
      warn: ((o: unknown) => void warns.push(o)) as never,
      error: ((o: unknown) => void errors.push(o)) as never,
    },
  });
  return { svc, warns, errors, apps };
}

it('[AC-F1-02c] reads the viewer app and answers the assembled config', async () => {
  const s = service({ ...REQUIRED, texts: { a: 'b' } });
  const config = await s.svc.read({ appId: 'app1', userId: null }, null);
  expect(config.texts).toEqual({ a: 'b' });
  expect([...s.apps]).toEqual(['app1']);
});

it('[AC-F1-02c] a missing required key rejects and logs the key at error', async () => {
  const s = service(Object.fromEntries(Object.entries(REQUIRED).filter(([k]) => k !== 'kf')));
  await expect(s.svc.read({ appId: 'a', userId: null }, null)).rejects.toBeInstanceOf(
    ClientConfigUnavailableError,
  );
  expect(s.errors).toEqual([expect.objectContaining({ config_key: 'kf' })]);
});

it('[AC-F1-02c] a malformed optional key warns with the key and keeps the default', async () => {
  const s = service({ ...REQUIRED, dict_version: 12 });
  expect((await s.svc.read({ appId: 'a', userId: null }, null)).dict_version).toBe('0');
  expect(s.warns).toEqual([expect.objectContaining({ config_key: 'dict_version' })]);
});

it('[AC-F1-02c] a failed read rejects, never a default answer', async () => {
  const s = service(REQUIRED, new Error('down'));
  await expect(s.svc.read({ appId: 'a', userId: null }, null)).rejects.toThrow('down');
});

it('[AC-F1-02d] unavailable media omits the key and warns with the app id', async () => {
  const s = service(REQUIRED, undefined, () => Promise.reject(new MediaStoreUnavailableError()));
  const config = await s.svc.read({ appId: 'app1', userId: null }, null);
  expect(Object.hasOwn(config, 'platform_icons')).toBe(false);
  expect(config.h5_base_url).toBe(REQUIRED['h5_base_url']);
  expect(s.warns).toEqual([{ event: 'content_config_platform_icons_unavailable', app_id: 'app1' }]);
});

it('[AC-F1-02d] icon database errors reject even after a successful config read', async () => {
  let fail = false;
  const failure = new Error('icon database unavailable');
  const s = service(REQUIRED, undefined, () =>
    fail ? Promise.reject(failure) : Promise.resolve({}),
  );
  expect((await s.svc.read({ appId: 'app1', userId: null }, null)).platform_icons).toEqual({});
  fail = true;
  await expect(s.svc.read({ appId: 'app1', userId: null }, null)).rejects.toBe(failure);
  expect(s.warns).toEqual([]);
});

function oracle(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oracle).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${oracle(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value)!;
}

it('[AC-F1-02h] config_version hashes the final JSON data, platform_icons included', async () => {
  const icons = { taobao: { version: 1 } } as never;
  const s = service(REQUIRED, undefined, () => Promise.resolve(icons));
  const config = await s.svc.read({ appId: 'a', userId: null }, null);
  const wire = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete wire['config_version'];
  const expected = createHash('sha256').update(oracle(wire)).digest('hex').slice(0, 32);
  expect(config.config_version).toBe(expected);
  expect(config.platform_icons).toEqual(icons);
  const plain = await service(REQUIRED).svc.read({ appId: 'a', userId: null }, null);
  expect(plain.config_version).not.toBe(config.config_version);
});

it('[AC-F1-02h] the same data in another app gets the same config_version', async () => {
  const a = await service(REQUIRED).svc.read({ appId: 'a1', userId: null }, null);
  const b = await service(REQUIRED).svc.read({ appId: 'a2', userId: null }, null);
  expect(a.config_version).toMatch(/^[0-9a-f]{32}$/);
  expect(b.config_version).toBe(a.config_version);
});

it('[AC-F1-02h] rank_platforms comes from the selectable material channels', async () => {
  const s = service(REQUIRED, undefined, undefined, {
    version: 'synthetic',
    channels: [
      {
        platform: 'jd',
        channel_id: 'c1',
        name: 'n',
        sort_basis: 'sales',
        selectable: true,
        source: 's',
      },
      {
        platform: 'taobao',
        channel_id: 'c2',
        name: 'n',
        sort_basis: 'sales',
        selectable: false,
        source: 's',
      },
    ],
  });
  const config = await s.svc.read({ appId: 'a', userId: null }, null);
  expect(config.features.rank_platforms).toEqual(['jd']);
});

it('[AC-F1-02j] a malformed clipboard warns with the key only, never the value', async () => {
  const s = service({
    ...REQUIRED,
    clipboard: { consent_version: 'secret-marker'.repeat(6), min_len: 10 },
  });
  expect((await s.svc.read({ appId: 'a', userId: null }, null)).clipboard).toEqual({});
  expect(s.warns).toEqual([
    { event: 'content_config_value_invalid', app_id: 'a', config_key: 'clipboard' },
  ]);
  expect(JSON.stringify(s.warns)).not.toContain('secret-marker');
});

const ON = 'growth.invite_reward.enabled';
const AMOUNT = 'growth.invite_reward.amount_fen';

function rewardService(
  values: Record<string, Record<string, unknown>>,
  budgets: Map<string, number | null | Error>,
  installed = true,
) {
  const warns: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const port: InviteRewardBudgetReader = {
    available: (appId) => {
      calls.push(appId);
      const value = budgets.get(appId) ?? null;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
  const reader: ContentReader = {
    appVersion: () => Promise.resolve(null),
    minSupportedVersion: () => Promise.resolve(null),
    configValue: (appId, key) => {
      const app = { ...REQUIRED, ...values[appId] };
      return Promise.resolve(
        Object.hasOwn(app, key) ? { value: app[key] as never, version: 1 } : null,
      );
    },
  };
  const svc = new ClientConfigService({
    reader,
    platformIcons: () => Promise.resolve({}),
    linkPatterns: () =>
      ({ version: 'lp', rules: [] }) as NonNullable<ClientConfig['link_patterns']>,
    materialChannels: () => ({ version: 'empty', channels: [] }),
    inviteRewardBudget: installed ? port : null,
    logger: {
      warn: ((o: Record<string, unknown>) => void warns.push(o)) as never,
      error: (() => undefined) as never,
    },
  });
  const read = (appId: string) => svc.read({ appId, userId: null }, null);
  return { read, warns, calls };
}

it('[AC-F1-02zp] the switch off or the port absent never asks the budget port', async () => {
  const budgets = new Map([['a', 5000]]);
  const off = rewardService({ a: { [ON]: false, [AMOUNT]: 500 } }, budgets);
  expect((await off.read('a')).invite).toMatchObject({
    reward_enabled: false,
    reward_amount_fen: 500,
  });
  expect(off.calls).toEqual([]);
  const absent = rewardService({ a: { [ON]: true } }, budgets, false);
  expect((await absent.read('a')).invite).toMatchObject({
    reward_enabled: false,
    reward_amount_fen: 1000,
  });
  expect(absent.calls).toEqual([]);
  expect(absent.warns).toEqual([]);
});

it('[AC-F1-02zp] a rejected or non-integer budget hides the reward with one warning', async () => {
  for (const value of [new Error('synthetic'), 1.5, Number.NaN]) {
    const s = rewardService({ a: { [ON]: true } }, new Map([['a', value]]));
    const config = await s.read('a');
    expect(config.invite).toMatchObject({ reward_enabled: false, reward_amount_fen: 1000 });
    expect(s.calls).toEqual(['a']);
    expect(s.warns).toEqual([
      expect.objectContaining({ event: 'content_config_invite_budget_unavailable', app_id: 'a' }),
    ]);
  }
  const nothing = rewardService({ a: { [ON]: true } }, new Map([['a', null]]));
  expect((await nothing.read('a')).invite.reward_enabled).toBe(false);
});

it('[AC-F1-02zp] two apps swapping budgets swap results; the version follows', async () => {
  // §9.12: no per-app cache may leak one app's budget into another's answer.
  const values = { a: { [ON]: true }, b: { [ON]: true } };
  const budgets = new Map<string, number | null | Error>([
    ['a', 2000],
    ['b', 1999],
  ]);
  const s = rewardService(values, budgets);
  const a1 = await s.read('a');
  const b1 = await s.read('b');
  expect([a1.invite.reward_enabled, b1.invite.reward_enabled]).toEqual([true, false]);
  budgets.set('a', 1999);
  budgets.set('b', 2000);
  const a2 = await s.read('a');
  const b2 = await s.read('b');
  expect([a2.invite.reward_enabled, b2.invite.reward_enabled]).toEqual([false, true]);
  expect(a2.config_version).toBe(b1.config_version);
  expect(b2.config_version).toBe(a1.config_version);
  expect(a1.config_version).not.toBe(b1.config_version);
  expect(s.calls).toEqual(['a', 'b', 'a', 'b']);
});

const DAYS = 'growth.invite_reward.eligibility_days';

it('[AC-F1-02zze] invite.eligibility_days is read with the other keys and moves the version', async () => {
  const values: Record<string, Record<string, unknown>> = { a: { [DAYS]: 45 } };
  const s = rewardService(values, new Map());
  const first = await s.read('a');
  expect(first.invite).toMatchObject({
    eligibility_days: 45,
    reward_enabled: false,
    reward_amount_fen: 1000,
  });
  values['a'] = { [DAYS]: 60 };
  const second = await s.read('a');
  expect(second.invite.eligibility_days).toBe(60);
  expect(second.config_version).not.toBe(first.config_version);
  expect({
    ...second,
    config_version: '',
    invite: { ...second.invite, eligibility_days: 45 },
  }).toEqual({ ...first, config_version: '' });
  expect(s.warns).toEqual([]);
});

it('[AC-F1-02zze] a malformed eligibility_days still answers 30 with one warning', async () => {
  const s = rewardService({ a: { [DAYS]: 3651, 'invite.eligibility_days': 7 } }, new Map());
  const config = await s.read('a');
  expect(config.invite.eligibility_days).toBe(30);
  expect(s.warns).toEqual([
    expect.objectContaining({
      event: 'content_config_value_invalid',
      config_key: DAYS,
      app_id: 'a',
    }),
  ]);
});
