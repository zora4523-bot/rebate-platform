// specs/app-stores.yaml (03 §4.1) structure check (CT-19b).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import { appStoresFile, checkAppStoreDoc, checkAppStores } from './app-stores.ts';
import { loadEnums } from './catalog.ts';

const enums = loadEnums();

function store(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: null,
    name: '某商店',
    platform: 'android',
    channels: ['official'],
    install_source_packages: [],
    detail_page: { open_method: null, target: null },
    source: '测试',
    ...over,
  };
}

it('the committed table passes the check and holds no listed version', () => {
  expect(checkAppStores(enums)).toEqual([]);
  const raw = readFileSync(appStoresFile, 'utf8');
  expect(raw).not.toMatch(/listed_version/);
  const doc = parseYamlLite(raw) as { stores: Array<{ channels: string[] }> };
  expect(doc.stores.flatMap((s) => s.channels).sort()).toEqual(['agc', 'appstore', 'huawei']);
});

it('accepts filled values', () => {
  const doc = {
    version: '1',
    stores: [
      store({ key: 'store_a', install_source_packages: ['com.example.market'] }),
      store({ key: 'store_b', detail_page: { open_method: 'intent', target: 'x://{id}' } }),
    ],
  };
  expect(checkAppStoreDoc(doc, enums)).toEqual([]);
});

it('rejects malformed entries', () => {
  const doc = {
    version: '',
    extra: 1,
    stores: [
      store({ key: 'Bad Key', platform: 'h5', channels: ['nope'] }),
      store({
        key: 'a',
        platform: 'ios',
        channels: ['appstore'],
        install_source_packages: ['com.x.y'],
      }),
      store({
        key: 'a',
        platform: 'ios',
        channels: ['appstore'],
        detail_page: { open_method: '' },
      }),
      { name: 'x' },
    ],
  };
  const p = checkAppStoreDoc(doc, enums).join('\n');
  expect(p).toMatch(/unknown top-level keys extra/);
  expect(p).toMatch(/version must be/);
  expect(p).toMatch(/key must be null or match/);
  expect(p).toMatch(/platform must be one of ios, android, harmony/);
  expect(p).toMatch(/"nope" is not an install_channel/);
  expect(p).toMatch(/install_source_packages is for android stores only/);
  expect(p).toMatch(/duplicate key a/);
  expect(p).toMatch(/detail_page needs open_method and target/);
  expect(p).toMatch(/channel appstore has a single store/);
  expect(p).toMatch(/stores\[3\]: missing key/);
});
