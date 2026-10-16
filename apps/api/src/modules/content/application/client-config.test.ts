import { expect, it } from 'vitest';
import { MediaStoreUnavailableError } from '../../platform/index.ts';
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
) {
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  const apps = new Set<string>();
  const reader: ContentReader = {
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
