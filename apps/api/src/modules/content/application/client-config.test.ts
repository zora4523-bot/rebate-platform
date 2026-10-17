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
