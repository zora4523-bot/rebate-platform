import { expect, it } from 'vitest';
import type { ClientConfig } from '../domain/client-config.ts';
import { ClientConfigService, ClientConfigUnavailableError } from './client-config.ts';
import type { ContentReader } from './content-reader.ts';

const REQUIRED: Record<string, unknown> = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};

function service(values: Record<string, unknown>, failure?: Error) {
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
